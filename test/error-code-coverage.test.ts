import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');
const TEST = path.resolve(__dirname, '..', 'test');
const GUARD = path.basename(__filename);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Error codes that are deliberately not asserted in this suite, because they
 * only occur under conditions a unit test cannot set up deterministically
 * (foreign processes, multi-second timeouts, or a full CLI run). Every entry
 * must state why; anything else has to gain a test.
 */
const UNTESTED: Record<string, string> = {
  DEVNET_NOT_READY: 'requires a pid file naming a live but unresponsive anvil',
  DEVNET_PORT_IN_USE: 'requires a foreign process to already own the devnet port',
  DEVNET_START_TIMEOUT: 'requires anvil to never become ready (up to 20s)',
  FEE_ESTIMATE_UNAVAILABLE: 'requires an RPC returning neither EIP-1559 fees nor a legacy gas price',
  FORK_SOURCE_UNSET: 'requires a base-fork environment and runtime fixture',
  RESUME_MISMATCH: 'deploy CLI --resume path against a mismatched existing record',
  VERIFY_OUTPUT_EXISTS: 'verify-live CLI refusal, reachable only after a full live run',
};

describe('ConfigError code coverage', () => {
  it('asserts every emitted code, or documents why it cannot be', () => {
    const emitted = new Set<string>();
    for (const file of tsFiles(SRC)) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/ConfigError\(\s*'([A-Z0-9_]+)'/g)) {
        emitted.add(match[1]!);
      }
    }
    expect(emitted.size).toBeGreaterThan(50);

    const testText = tsFiles(TEST)
      .filter((file) => path.basename(file) !== GUARD)
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    const uncovered = [...emitted].filter((code) => !testText.includes(`'${code}'`)).sort();
    expect(uncovered).toEqual(Object.keys(UNTESTED).sort());
  });
});
