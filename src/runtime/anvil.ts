import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RpcTransport } from './transport';
import { ConfigError } from '../errors';

export interface AnvilOptions {
  port: number;
  chainId?: number;
  /** Persisted-state file (anvil --state): loaded if present, dumped on exit. */
  stateFile?: string;
  /** Periodic persisted-state interval in seconds. */
  stateInterval?: number;
  /** Retain block-pinned states for historical eth_getCode/readback checks. */
  preserveHistoricalStates?: boolean;
  /**
   * Pid file for the Anvil process serving `port`. Devnet lifecycle commands
   * run in a separate process from the one that spawned Anvil, so ownership
   * has to be recoverable from disk rather than from a `ChildProcess` handle.
   */
  pidFile?: string;
  /** Fork configuration (optional). */
  forkUrl?: string;
  forkBlock?: number;
  silent?: boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function looksLikeAnvil(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.split('\0').some((part) => path.basename(part) === 'anvil');
  } catch {
    // No /proc (non-Linux): the pid file is written only by start(), so trust it
    // and rely on the port liveness check that always accompanies it.
    return true;
  }
}

/**
 * Local Anvil lifecycle backed by Anvil's JSON state persistence.
 *
 * The persisted Anvil state is a runtime cache under `.devnet/`, NOT the
 * deployment ledger and never under `deployments/`. A clean devnet is always
 * reproducible from the declarative spec + fixtures + deployment machinery.
 *
 * The engine interacts only via ordinary JSON-RPC (`RpcTransport`); Anvil is
 * simply the process hosting that endpoint.
 */
export class AnvilRuntime {
  private proc: ChildProcess | null = null;
  private spawnedByUs = false;
  readonly rpcUrl: string;
  private readonly transport: RpcTransport;

  constructor(private readonly opts: AnvilOptions) {
    this.rpcUrl = `http://127.0.0.1:${opts.port}`;
    this.transport = new RpcTransport(this.rpcUrl);
  }

  get url(): string {
    return this.rpcUrl;
  }

  get rpc(): RpcTransport {
    return this.transport;
  }

  /** True only when this process spawned the chain and is still responsible for it. */
  get ownedByProcess(): boolean {
    return this.spawnedByUs && this.proc !== null;
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.transport.getChainId();
      return true;
    } catch {
      return false;
    }
  }

  private readPidFile(): number | null {
    if (!this.opts.pidFile || !fs.existsSync(this.opts.pidFile)) return null;
    const pid = Number.parseInt(fs.readFileSync(this.opts.pidFile, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  private writePidFile(pid: number): void {
    if (!this.opts.pidFile) return;
    fs.mkdirSync(path.dirname(this.opts.pidFile), { recursive: true });
    fs.writeFileSync(this.opts.pidFile, `${pid}\n`);
  }

  private clearPidFile(expectedPid?: number): void {
    if (!this.opts.pidFile || !fs.existsSync(this.opts.pidFile)) return;
    if (expectedPid !== undefined && this.readPidFile() !== expectedPid) return;
    fs.rmSync(this.opts.pidFile, { force: true });
  }

  /**
   * Adopt a devnet left running by an earlier process. Returns true when the
   * port is already served by the Anvil process named in the pid file.
   */
  private async reclaimExisting(): Promise<boolean> {
    const pid = this.readPidFile();
    if (pid === null) return false;
    if (!processAlive(pid) || !looksLikeAnvil(pid)) {
      this.clearPidFile(pid);
      return false;
    }
    if (await this.isRunning()) return true;
    throw new ConfigError(
      'DEVNET_NOT_READY',
      `Anvil pid ${pid} from the pid file owns ${this.rpcUrl} but is not responding`,
    );
  }

  async start(timeoutMs = 20000): Promise<void> {
    if (this.proc) {
      if (await this.isRunning()) return; // our own process already serving
      this.proc = null; // stale handle; respawn below
      this.spawnedByUs = false;
    }
    if (await this.reclaimExisting()) return;

    const args = ['--port', String(this.opts.port), '--host', '127.0.0.1'];
    if (this.opts.chainId !== undefined) args.push('--chain-id', String(this.opts.chainId));
    if (this.opts.forkUrl) {
      args.push('--fork-url', this.opts.forkUrl);
      if (this.opts.forkBlock !== undefined) args.push('--fork-block-number', String(this.opts.forkBlock));
    }
    if (this.opts.stateFile) {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      args.push('--state', this.opts.stateFile);
    }
    if (this.opts.stateInterval !== undefined) args.push('--state-interval', String(this.opts.stateInterval));
    if (this.opts.preserveHistoricalStates) args.push('--preserve-historical-states');
    args.push('--silent');

    const proc = spawn('anvil', args, {
      stdio: this.opts.silent === false ? ['ignore', 'inherit', 'inherit'] : 'ignore',
    });
    this.proc = proc;
    this.spawnedByUs = true;
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null;
        this.spawnedByUs = false;
        this.clearPidFile(proc.pid);
      }
    });

    // Wait for readiness, but fail loudly if the process exits early (e.g. a
    // foreign process already owns the port) rather than silently using it.
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!this.proc) {
        throw new ConfigError(
          'DEVNET_PORT_IN_USE',
          `Anvil exited before becoming ready on ${this.rpcUrl} — is another process using port ${this.opts.port}?`,
        );
      }
      try {
        await this.transport.getChainId();
        if (proc.pid !== undefined) this.writePidFile(proc.pid);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new ConfigError('DEVNET_START_TIMEOUT', `Anvil did not become ready on ${this.rpcUrl} within ${timeoutMs}ms`);
  }

  /**
   * Stop the chain. Returns true when this call actually stopped something,
   * so callers can distinguish "stopped" from "was not running".
   */
  async stop(timeoutMs = 15000): Promise<boolean> {
    const p = this.proc;
    if (!p) return this.stopRecoveredOwner(timeoutMs);
    p.kill('SIGTERM'); // anvil dumps persisted state on exit (--state)
    const start = Date.now();
    // Wait until the process is gone AND the port is no longer responding,
    // so a subsequent start() on the same port spawns a genuinely fresh node.
    while (Date.now() - start < timeoutMs) {
      if (!this.proc || !(await this.isRunning())) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    this.spawnedByUs = false;
    this.clearPidFile();
    // Allow the OS to release the listening socket before reuse.
    await new Promise((r) => setTimeout(r, 200));
    return true;
  }

  /**
   * Stop an Anvil that an *earlier* process spawned. `ChildProcess` handles do
   * not survive process boundaries, so ownership is recovered from the pid file
   * written at start time — without it, `devnet:stop` silently did nothing.
   */
  private async stopRecoveredOwner(timeoutMs: number): Promise<boolean> {
    const pid = this.readPidFile();
    if (pid === null) return false;
    if (!processAlive(pid) || !looksLikeAnvil(pid) || !(await this.isRunning())) {
      this.clearPidFile(pid);
      return false;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      this.clearPidFile(pid);
      return false;
    }
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!(await this.isRunning())) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (await this.isRunning()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    this.clearPidFile(pid);
    await new Promise((r) => setTimeout(r, 200));
    return true;
  }

  /** Remove persisted state so the next start is a clean chain. */
  resetState(): void {
    if (this.opts.stateFile && fs.existsSync(this.opts.stateFile)) {
      fs.rmSync(this.opts.stateFile, { force: true });
    }
  }

  /** Reset = stop (dump if running) then delete persisted state. */
  async reset(): Promise<void> {
    await this.stop();
    this.resetState();
  }
}
