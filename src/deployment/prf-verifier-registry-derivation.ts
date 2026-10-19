import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { ConfigError } from '../errors';
import { canonicalJson } from '../canonical-json';

export interface PrfVerifierRegistryEntryV1 {
  id: string;
  adapter: string;
  programVKey: string;
  programElfSha256: string;
  programId: string;
  statementSchemaVersionHash: string;
  publicValuesSchema: string;
  active: boolean;
}

export interface PrfVerifierRegistryDerivationEvidenceV1 {
  schema: 'prf-verifier-registry-derivation-evidence.v1';
  qualification: 'canonical-root-derived-and-solidity-equivalent';
  root: string;
  entry: PrfVerifierRegistryEntryV1;
  observationBlock: { number: string; hash: string };
  solidityRoot: string;
  requestSha256: string;
  outputSha256: string;
  output: string;
  verifierCommand: string[];
}

export type RegistryDerivationCommand = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8' },
) => { status: number | null; error?: Error; stdout?: string; stderr?: string };

/** Derive registry.v1 through PRF, then compare it with the live Solidity pure projection. */
export function derivePrfVerifierRegistryRoot(input: {
  prfRoot: string;
  entry: PrfVerifierRegistryEntryV1;
  observationBlock: { number: bigint; hash: string };
  solidityRoot: string;
}, run: RegistryDerivationCommand = (command, args, options) => spawnSync(command, args, options)): PrfVerifierRegistryDerivationEvidenceV1 {
  const prfRoot = path.resolve(input.prfRoot);
  const request = { schema: 'prf-verifier-registry-derivation-request.v1', entries: [input.entry] };
  const requestBytes = JSON.stringify(request);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-verifier-registry-'));
  const requestPath = path.join(directory, 'request.json');
  try {
    fs.writeFileSync(requestPath, requestBytes, { flag: 'wx', mode: 0o600 });
    const args = ['-M:test', '-m', 'scripts.deployment.registry-equivalence', 'derive-json', requestPath];
    const result = run('clojure', args, { cwd: prfRoot, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw new ConfigError('PRF_VERIFIER_REGISTRY_DERIVATION_REJECTED', 'PRF could not derive the successor verifier-registry root', {
        details: { exitCode: result.status, error: result.error?.message, output: (result.stderr ?? result.stdout ?? '').slice(-4000) },
      });
    }
    const output = result.stdout ?? '';
    let parsed: { schema?: unknown; root?: unknown; entries?: unknown };
    try { parsed = JSON.parse(output) as typeof parsed; }
    catch { throw new ConfigError('PRF_VERIFIER_REGISTRY_DERIVATION_INVALID', 'PRF returned malformed registry derivation JSON'); }
    if (parsed.schema !== 'prf-verifier-registry-derivation-result.v1' ||
        typeof parsed.root !== 'string' || !/^0x[0-9a-f]{64}$/.test(parsed.root) ||
        canonicalJson(parsed.entries) !== canonicalJson(request.entries) ||
        input.solidityRoot.toLowerCase() !== parsed.root.toLowerCase()) {
      throw new ConfigError('PRF_VERIFIER_REGISTRY_DERIVATION_MISMATCH', 'PRF registry root differs from the live Solidity canonical-root projection or the requested entry');
    }
    return {
      schema: 'prf-verifier-registry-derivation-evidence.v1',
      qualification: 'canonical-root-derived-and-solidity-equivalent',
      root: parsed.root,
      entry: input.entry,
      observationBlock: { number: input.observationBlock.number.toString(), hash: input.observationBlock.hash },
      solidityRoot: input.solidityRoot,
      requestSha256: createHash('sha256').update(requestBytes).digest('hex'),
      outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
      output,
      verifierCommand: ['clojure', ...args],
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
