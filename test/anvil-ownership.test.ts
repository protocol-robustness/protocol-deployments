import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnvilRuntime } from '../src/runtime/anvil';

let portCounter = 18700;
function nextPort(): number {
  return portCounter++;
}

const spawned: AnvilRuntime[] = [];
let tmp: string | null = null;

afterEach(async () => {
  for (const a of spawned) await a.stop().catch(() => {});
  spawned.length = 0;
  if (tmp) {
    fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function pidDir(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pid-'));
  return path.join(tmp, 'anvil.pid');
}

describe('Anvil pid-file ownership', () => {
  it('stops nothing when this process never spawned a chain', async () => {
    const orphan = new AnvilRuntime({ port: nextPort(), chainId: 31337, silent: true, pidFile: pidDir() });
    expect(orphan.ownedByProcess).toBe(false);
    await expect(orphan.stop()).resolves.toBe(false);
    expect(fs.existsSync(path.join(tmp!, 'anvil.pid'))).toBe(false);
  });

  it('never signals a pid that is not an anvil process', async () => {
    const pidFile = pidDir();
    fs.writeFileSync(pidFile, `${process.pid}\n`);
    const stranger = new AnvilRuntime({ port: nextPort(), chainId: 31337, silent: true, pidFile });

    await expect(stranger.stop()).resolves.toBe(false);
    // The stale entry is cleared so a later start does not trust it.
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(processAlive(process.pid)).toBe(true);
  });

  it('records ownership at start and lets a later process recover it', async () => {
    const pidFile = pidDir();
    const port = nextPort();
    const owner = new AnvilRuntime({ port, chainId: 31337, silent: true, pidFile });
    spawned.push(owner);
    await owner.start();

    expect(owner.ownedByProcess).toBe(true);
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isInteger(pid)).toBe(true);
    expect(processAlive(pid)).toBe(true);

    // A separate process sees no ChildProcess handle, only the pid file.
    const laterProcess = new AnvilRuntime({ port, chainId: 31337, silent: true, pidFile });
    expect(laterProcess.ownedByProcess).toBe(false);

    await expect(laterProcess.stop()).resolves.toBe(true);
    expect(fs.existsSync(pidFile)).toBe(false);
    await expect(owner.isRunning()).resolves.toBe(false);
    await expect(laterProcess.stop()).resolves.toBe(false);
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
