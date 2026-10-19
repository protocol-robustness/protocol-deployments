import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { ConfigError } from '../errors';

export interface PrfSuccessorApprovalInput {
  prfRoot: string;
  manifestPath: string;
  verifierRegistryPath: string;
  trustedContextPath: string;
  approvalPath: string;
}

export interface PrfSuccessorApprovalScope {
  'protocol/genesis-root': string;
  'execution/chain-id': number;
  'chain-instance-genesis-root': string;
  'configuration/parent-root': string;
  'configuration/new-root': string;
  epoch: number;
  'entitlement-proof-mode': number;
  qualification: string;
}

export interface PrfSuccessorApprovalEvidence {
  schema: 'prf-successor-transition-approval-verification.v1';
  verifierCommand: string[];
  inputs: Array<{ role: string; path: string; sha256: string }>;
  output: string;
  outputSha256: string;
  manifestRoot: string;
  scope: PrfSuccessorApprovalScope;
}

export type PrfSuccessorApprovalCommand = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8' },
) => { status: number | null; error?: Error; stdout?: string; stderr?: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Verify the detached transition approval independently and bind it to the
 * deployment's expected C0/C1, instance, chain, epoch and proof-mode scope. */
export function verifyPrfSuccessorTransitionApproval(
  input: PrfSuccessorApprovalInput,
  expectedScope: PrfSuccessorApprovalScope,
  run: PrfSuccessorApprovalCommand = (command, args, options) => spawnSync(command, args, options),
): PrfSuccessorApprovalEvidence {
  const prfRoot = path.resolve(input.prfRoot);
  const files = [input.manifestPath, input.verifierRegistryPath, input.trustedContextPath, input.approvalPath]
    .map((file) => path.resolve(prfRoot, file));
  for (const file of files) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); }
    catch (error) {
      throw new ConfigError('PRF_SUCCESSOR_APPROVAL_INPUT_MISSING', `Required PRF successor-approval input is unavailable: ${path.relative(prfRoot, file)}`, {
        path: file, details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    if (!stat.isFile()) throw new ConfigError('PRF_SUCCESSOR_APPROVAL_INPUT_INVALID', `PRF approval input is not a regular file: ${path.relative(prfRoot, file)}`, { path: file });
  }
  const relativeFiles = files.map((file) => path.relative(prfRoot, file));
  const args = ['-M:test', '-m', 'scripts.deployment.successor-transition-review', 'verify-json', ...relativeFiles];
  const result = run('clojure', args, { cwd: prfRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new ConfigError('PRF_SUCCESSOR_APPROVAL_REJECTED', 'PRF rejected the successor-transition approval or could not run its independent verifier', {
      details: { exitCode: result.status, error: result.error?.message, output: (result.stderr ?? result.stdout ?? '').slice(-4000) },
    });
  }
  const output = result.stdout ?? '';
  let verification: { valid?: unknown; qualification?: unknown; 'manifest-root'?: unknown; scope?: unknown };
  try { verification = JSON.parse(output) as typeof verification; }
  catch { throw new ConfigError('PRF_SUCCESSOR_APPROVAL_INVALID_RESULT', 'PRF transition verifier returned malformed JSON'); }
  if (verification.valid !== true || verification.qualification !== 'authenticated-successor-transition' ||
      typeof verification['manifest-root'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(verification['manifest-root']) ||
      !verification.scope || typeof verification.scope !== 'object' ||
      stableJson(verification.scope) !== stableJson(expectedScope)) {
    throw new ConfigError('PRF_SUCCESSOR_APPROVAL_SCOPE_MISMATCH', 'PRF transition approval does not authenticate the exact expected deployment scope', {
      details: { qualification: verification.qualification, expectedScope, actualScope: verification.scope },
    });
  }
  return {
    schema: 'prf-successor-transition-approval-verification.v1',
    verifierCommand: ['clojure', ...args],
    inputs: files.map((file, index) => ({
      role: ['transition-manifest', 'verifier-registry', 'trusted-context', 'approval-envelope'][index]!,
      path: path.relative(prfRoot, file),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    })),
    output,
    outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
    manifestRoot: verification['manifest-root'],
    scope: verification.scope as PrfSuccessorApprovalScope,
  };
}
