import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { ConfigError } from '../errors';

export interface PrfInitialApprovalInput {
  prfRoot: string;
  manifestPath: string;
  packageSetPath: string;
  trustedContextPath: string;
  approvalPath: string;
}

export interface PrfApprovalCommandResult {
  status: number | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}

export interface PrfInitialApprovalEvidence {
  schema: 'prf-initial-input-approval-verification.v1';
  verifierCommand: string[];
  inputs: Array<{ role: string; path: string; sha256: string }>;
  output: string;
  outputSha256: string;
  manifestRoot: string;
  approvedRootBindings: PrfApprovedRootBindings;
}

export interface PrfApprovedRootBindings {
  protocolGenesisRoot: string;
  authorityStateRoot: string;
  localAuthorityPolicyRoot: string;
  initialConfigurationRoot: string;
  initialVerifierRegistryRoot: string;
  authorityTransitionValidatorAddress: string;
}

export type PrfApprovalCommand = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8' },
) => PrfApprovalCommandResult;

/** Require PRF's independent content, source-lock, scope and signature verifier
 * before a bounded deployment can send its first transaction. Trusted context
 * remains a separate operator-controlled file. */
export function verifyPrfInitialInputApproval(
  input: PrfInitialApprovalInput,
  run: PrfApprovalCommand = (command, args, options) => spawnSync(command, args, options),
): PrfInitialApprovalEvidence {
  const prfRoot = path.resolve(input.prfRoot);
  const files = [input.manifestPath, input.packageSetPath, input.trustedContextPath, input.approvalPath]
    .map((file) => path.resolve(prfRoot, file));
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      throw new ConfigError('PRF_INITIAL_APPROVAL_INPUT_MISSING', `Required PRF initial-approval input is unavailable: ${path.relative(prfRoot, file)}`, {
        path: file,
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    if (!stat.isFile()) throw new ConfigError('PRF_INITIAL_APPROVAL_INPUT_INVALID', `PRF approval input is not a regular file: ${path.relative(prfRoot, file)}`, { path: file });
  }
  const [manifest, packageSet, trustedContext, approval] = files;
  const relativeFiles = files.map((file) => path.relative(prfRoot, file));
  const args = [
    '-M:test', '-m', 'scripts.deployment.configuration-review', 'verify-json',
    ...relativeFiles,
  ];
  const result = run('clojure', args, { cwd: prfRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new ConfigError('PRF_INITIAL_APPROVAL_REJECTED', 'PRF rejected the initial-input approval or could not run its independent verifier', {
      details: {
        exitCode: result.status,
        error: result.error?.message,
        output: (result.stderr ?? result.stdout ?? '').slice(-4000),
      },
    });
  }
  const roles = ['manifest', 'package-set', 'trusted-context', 'approval-envelope'];
  const output = result.stdout ?? '';
  let verification: {
    valid?: unknown;
    qualification?: unknown;
    source?: { valid?: unknown };
    'manifest-root'?: unknown;
    'canonical-roots'?: Record<string, unknown>;
    'initial-configuration'?: Record<string, unknown>;
  'authority-transition-validator-address'?: unknown;
  };
  try {
    verification = JSON.parse(output) as typeof verification;
  } catch {
    throw new ConfigError('PRF_INITIAL_APPROVAL_INVALID_RESULT', 'PRF verifier returned malformed structured output');
  }
  if (verification.valid !== true ||
      verification.qualification !== 'authenticated-content-approval' ||
      verification.source?.valid !== true ||
      typeof verification['manifest-root'] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(verification['manifest-root'])) {
    throw new ConfigError('PRF_INITIAL_APPROVAL_INVALID_RESULT', 'PRF verifier output does not prove authenticated source-bound initial-input approval');
  }
  const rootRef = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new ConfigError('PRF_INITIAL_APPROVAL_INVALID_RESULT', `PRF verifier omitted the approved ${label} root`);
    }
    return `0x${value.slice('sha256:'.length)}`;
  };
  const roots = verification['canonical-roots'];
  const initialConfiguration = verification['initial-configuration'];
  if (!roots || !initialConfiguration) throw new ConfigError('PRF_INITIAL_APPROVAL_INVALID_RESULT', 'PRF verifier omitted the approved canonical root set');
  const validatorAddress = verification['authority-transition-validator-address'];
  if (typeof validatorAddress !== 'string' || !/^0x[0-9a-f]{40}$/.test(validatorAddress) || /^0x0{40}$/.test(validatorAddress)) {
    throw new ConfigError('PRF_INITIAL_APPROVAL_INVALID_RESULT', 'PRF verifier omitted a valid policy-v3 transition-validator address');
  }
  const approvedRootBindings: PrfApprovedRootBindings = {
    protocolGenesisRoot: rootRef(roots['protocol-genesis'], 'protocol genesis'),
    authorityStateRoot: rootRef(roots['authority-state'], 'authority state'),
    localAuthorityPolicyRoot: rootRef(roots['local-authority-policy'], 'local authority policy'),
    initialConfigurationRoot: rootRef(roots['initial-configuration'], 'initial configuration'),
    initialVerifierRegistryRoot: rootRef(initialConfiguration['verifier-registry/root'], 'empty verifier registry'),
    authorityTransitionValidatorAddress: validatorAddress,
  };
  return {
    schema: 'prf-initial-input-approval-verification.v1',
    verifierCommand: ['clojure', ...args],
    inputs: files.map((file, index) => ({
      role: roles[index]!,
      path: path.relative(prfRoot, file),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    })),
    output,
    outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
    manifestRoot: verification['manifest-root'],
    approvedRootBindings,
  };
}
