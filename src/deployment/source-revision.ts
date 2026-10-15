import { execFileSync } from 'child_process';
import { ConfigError } from '../errors';

/** Bind a receipt's declared source revision to the clean checkout executing the CLI. */
export function assertSourceRevisionMatchesCheckout(expected: string, cwd = process.cwd()): void {
  let head: string;
  let status: string;
  try {
    head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  } catch (error) {
    throw new ConfigError('SOURCE_REVISION_CHECK_FAILED', `Cannot authenticate source revision from the executing checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSourceRevisionIdentity(expected, head, status.length === 0);
}

export function assertSourceRevisionIdentity(expected: string, head: string, clean: boolean): void {
  if (!/^[0-9a-f]{40,64}$/i.test(expected) || expected.toLowerCase() !== head.toLowerCase()) {
    throw new ConfigError('SOURCE_REVISION_MISMATCH', `Declared source revision '${expected}' does not match executing checkout HEAD '${head}'`);
  }
  if (!clean) throw new ConfigError('SOURCE_CHECKOUT_DIRTY', 'Stage-output verification requires a clean source checkout');
}
