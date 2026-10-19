import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { ConfigError } from '../errors';

export interface PrfAuthorityTransitionInput {
  prfRoot: string;
  requestPath: string;
  trustedContextPath: string;
}

export interface PrfAuthorityTransitionScope {
  'chain-instance-genesis-root': string;
  'adapter-address': string;
  'previous-root': string;
  'successor-root': string;
  'policy-root': string;
  'decision-root': string;
  'transition-root': string;
  'execution-commitment': string;
  'previous-revision': number;
  'successor-revision': number;
}

export interface PrfAuthorityMutation {
  kind: number;
  decisionRoot: string;
  targetMode: number;
  targetRoot: string;
  parentConfigurationRoot: string;
  newConfigurationRoot: string;
  parentVerifierRegistryRoot: string;
  newVerifierRegistryRoot: string;
  epoch: number;
  proofMode: number;
}

export interface PrfAuthorityTransitionEvidence {
  schema: 'prf-authority-transition-verification.v1';
  verifierCommand: string[];
  inputs: Array<{ role: string; path: string; sha256: string }>;
  output: string;
  outputSha256: string;
  scope: PrfAuthorityTransitionScope;
  decisionPreimagesRoot: string;
  executionMutationRoot: string;
  mutations: PrfAuthorityMutation[];
  attestation: `0x${string}`;
}

export type PrfAuthorityTransitionCommand = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8' },
) => { status: number | null; error?: Error; stdout?: string; stderr?: string };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fail(code: string, message: string): never { throw new ConfigError(code, message); }

/** Require PRF's independent semantic, C1-preimage and EIP-191 verifier. */
export function verifyPrfAuthorityTransition(
  input: PrfAuthorityTransitionInput,
  expectedScope: Partial<PrfAuthorityTransitionScope>,
  run: PrfAuthorityTransitionCommand = (command, args, options) => spawnSync(command, args, options),
): PrfAuthorityTransitionEvidence {
  const prfRoot = path.resolve(input.prfRoot);
  const files = [input.requestPath, input.trustedContextPath].map((file) => path.resolve(prfRoot, file));
  for (const file of files) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); }
    catch (error) {
      throw new ConfigError('PRF_AUTHORITY_TRANSITION_INPUT_MISSING', `Authority-transition input is unavailable: ${path.relative(prfRoot, file)}`, {
        path: file, details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    if (!stat.isFile()) throw new ConfigError('PRF_AUTHORITY_TRANSITION_INPUT_INVALID', `Authority-transition input is not a regular file: ${path.relative(prfRoot, file)}`, { path: file });
  }
  const relativeFiles = files.map((file) => path.relative(prfRoot, file));
  const args = ['-M:test', '-m', 'scripts.deployment.authority-transition-review', 'verify-json', ...relativeFiles];
  const result = run('clojure', args, { cwd: prfRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new ConfigError('PRF_AUTHORITY_TRANSITION_REJECTED', 'PRF rejected the authority-state transition or its EIP-191 attestation', {
      details: { exitCode: result.status, error: result.error?.message, output: (result.stderr ?? result.stdout ?? '').slice(-4000) },
    });
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(result.stdout ?? '') as Record<string, unknown>; }
  catch { return fail('PRF_AUTHORITY_TRANSITION_INVALID_RESULT', 'PRF authority-transition verifier returned malformed JSON'); }
  if (parsed.valid !== true || parsed.qualification !== 'authenticated-authority-transition' ||
      !parsed.scope || typeof parsed.scope !== 'object') {
    throw new ConfigError('PRF_AUTHORITY_TRANSITION_INVALID_RESULT', 'PRF did not authenticate the authority-state transition');
  }
  const scope = parsed.scope as PrfAuthorityTransitionScope;
  const selectedScope = Object.fromEntries(Object.keys(expectedScope).map((key) => [key, (scope as unknown as Record<string, unknown>)[key]]));
  if (canonicalJson(selectedScope) !== canonicalJson(expectedScope)) {
    throw new ConfigError('PRF_AUTHORITY_TRANSITION_SCOPE_MISMATCH', 'Authority transition differs from the exact live C1 deployment scope', {
      details: { expectedScope, actualScope: scope },
    });
  }
  const hex32 = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
  if (!hex32(parsed['decision-preimages-root']) || !hex32(parsed['execution-mutation-root']) ||
      typeof parsed.attestation !== 'string' || !/^0x[0-9a-f]{130}$/.test(parsed.attestation) ||
      !Array.isArray(parsed.mutations) || parsed.mutations.length === 0) {
    throw new ConfigError('PRF_AUTHORITY_TRANSITION_INVALID_RESULT', 'PRF verifier output omitted canonical mutation or attestation data');
  }
  const mutations = parsed.mutations.map((raw): PrfAuthorityMutation => {
    if (!raw || typeof raw !== 'object') return fail('PRF_AUTHORITY_TRANSITION_INVALID_RESULT', 'PRF returned a malformed authority mutation');
    const mutation = raw as Record<string, unknown>;
    const numbers = ['kind', 'targetMode', 'epoch', 'proofMode'];
    if (numbers.some((key) => !Number.isInteger(mutation[key])) ||
        ![0, 1, 2].includes(mutation.kind as number) || !hex32(mutation.decisionRoot) ||
        !hex32(mutation.targetRoot) || !hex32(mutation.parentConfigurationRoot) ||
        !hex32(mutation.newConfigurationRoot) || !hex32(mutation.parentVerifierRegistryRoot) ||
        !hex32(mutation.newVerifierRegistryRoot)) {
      return fail('PRF_AUTHORITY_TRANSITION_INVALID_RESULT', 'PRF returned non-canonical mutation fields');
    }
    return mutation as unknown as PrfAuthorityMutation;
  });
  return {
    schema: 'prf-authority-transition-verification.v1',
    verifierCommand: ['clojure', ...args],
    inputs: files.map((file, index) => ({
      role: index === 0 ? 'transition-request' : 'trusted-transition-context',
      path: path.relative(prfRoot, file),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    })),
    output: result.stdout ?? '',
    outputSha256: createHash('sha256').update(result.stdout ?? '', 'utf8').digest('hex'),
    scope,
    decisionPreimagesRoot: parsed['decision-preimages-root'] as string,
    executionMutationRoot: parsed['execution-mutation-root'] as string,
    mutations,
    attestation: parsed.attestation as `0x${string}`,
  };
}
