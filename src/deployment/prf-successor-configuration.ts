import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { ConfigError } from '../errors';
import { canonicalJson } from '../canonical-json';

export interface PrfSuccessorConfigurationEvidence {
  schema: 'prf-successor-configuration-evidence.v1';
  qualification: 'successor-configuration-independently-derived-not-approved';
  request: Record<string, unknown>;
  requestSha256: string;
  outputSha256: string;
  output: string;
  verifierCommand: string[];
  derivation: Record<string, unknown>;
}

export type PrfSuccessorConfigurationCommand = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8' },
) => { status: number | null; error?: Error; stdout?: string; stderr?: string };

/** Recompute C0 -> C1 from the approved C0, sealed instance artifact, and
 * independently derived successor registry root. This produces no approval. */
export function derivePrfSuccessorConfiguration(input: {
  prfRoot: string;
  initialConfiguration: Record<string, unknown>;
  protocolGenesisRoot: string;
  chainInstanceGenesis: Record<string, unknown>;
  expectedChainInstanceGenesisRoot: string;
  expectedInitialConfigurationRoot: string;
  successorVerifierRegistryRoot: string;
  successorProofMode: number;
  epoch: number;
}, run: PrfSuccessorConfigurationCommand = (command, args, options) => spawnSync(command, args, options)): PrfSuccessorConfigurationEvidence {
  const root = path.resolve(input.prfRoot);
  const request = {
    'initial-configuration': input.initialConfiguration,
    'protocol-genesis-root': input.protocolGenesisRoot,
    'chain-instance-genesis': input.chainInstanceGenesis,
    'expected-chain-instance-genesis-root': input.expectedChainInstanceGenesisRoot,
    'expected-initial-configuration-root': input.expectedInitialConfigurationRoot,
    'successor-verifier-registry-root': input.successorVerifierRegistryRoot,
    'successor-proof-mode': input.successorProofMode,
    epoch: input.epoch,
  };
  const requestBytes = JSON.stringify(request);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-successor-configuration-'));
  const requestPath = path.join(dir, 'request.json');
  try {
    fs.writeFileSync(requestPath, requestBytes, { flag: 'wx', mode: 0o600 });
    const args = ['-M:test', '-m', 'scripts.deployment.successor-configuration', 'derive-json', requestPath];
    const result = run('clojure', args, { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_REJECTED', 'PRF rejected independent successor-configuration derivation', {
        details: { exitCode: result.status, error: result.error?.message, output: (result.stderr ?? result.stdout ?? '').slice(-4000) },
      });
    }
    const output = result.stdout ?? '';
    let derivation: Record<string, unknown>;
    try { derivation = JSON.parse(output) as Record<string, unknown>; }
    catch { throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_INVALID', 'PRF returned malformed successor derivation JSON'); }
    const target = derivation['configuration-transition'] as Record<string, unknown> | undefined;
    const changed = derivation['changed-fields'];
    const rootRef = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
    if (derivation.schema !== 'prf-successor-configuration-derivation.v1' ||
        derivation.qualification !== 'derived-only-not-approved' ||
        !rootRef(derivation['configuration/C0-root']) || !rootRef(derivation['configuration/C1-root']) ||
        derivation['configuration/C0-root'] !== input.expectedInitialConfigurationRoot ||
        derivation['configuration/C0-root'] === derivation['configuration/C1-root'] ||
        derivation['chain-instance-genesis-root'] !== input.expectedChainInstanceGenesisRoot ||
        derivation['successor-verifier-registry-root'] !== input.successorVerifierRegistryRoot ||
        derivation['successor-proof-mode'] !== input.successorProofMode ||
        !Array.isArray(changed) || canonicalJson(changed) !== canonicalJson(['verifier-registry/root']) ||
        !rootRef(target?.['configuration/parent-root']) || !rootRef(target?.['configuration/new-root']) ||
        target?.['configuration/parent-root'] !== derivation['configuration/C0-root'] ||
        target?.['configuration/new-root'] !== derivation['configuration/C1-root'] ||
        target?.['verifier-registry/root'] !== input.successorVerifierRegistryRoot ||
        target?.epoch !== input.epoch) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_MISMATCH', 'PRF successor derivation does not bind the approved instance, C0/C1 roots, exact registry root and sole permitted field change');
    }
    return {
      schema: 'prf-successor-configuration-evidence.v1',
      qualification: 'successor-configuration-independently-derived-not-approved',
      request,
      requestSha256: createHash('sha256').update(requestBytes).digest('hex'),
      outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
      output, verifierCommand: ['clojure', ...args], derivation,
    };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
