import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { ConfigError } from '../errors';

export interface PrfGenesisSealPreflightInput {
  prfRoot: string;
  requestPath: string;
  trustedContextPath: string;
  rpcUrl: string;
  genesisAddress: string;
  authorityAdapterAddress: string;
  expectedCall: { from: string; target: string; function: string; args: unknown[] };
  expectedManifestRoot: string;
}

export interface PrfGenesisSealPreflightEvidence {
  schema: 'prf-chain-instance-seal-preflight.v2';
  qualification: 'approved-inputs-and-live-observations-verified';
  manifestRoot: string;
  sourceTreeSha256: string;
  computedRoot: string;
  sealCall: { from: string; target: string; function: string; args: string[] };
  derivedArguments: string[];
  observationBlocks: unknown;
  sourceFileCount: number;
  verifierCommand: string[];
  inputs: Array<{ role: string; path: string; sha256: string }>;
  output: string;
  outputSha256: string;
}

export interface PrfGenesisSealResultEvidence {
  schema: 'prf-chain-instance-seal-result.v1';
  qualification: 'seal-receipt-and-readback-verified';
  manifestRoot: string;
  chainInstanceGenesisRoot: string;
  receipt: unknown;
  preflightOutputSha256: string;
  verifierCommand: string[];
  inputs: Array<{ role: string; path: string; sha256: string }>;
  output: string;
  outputSha256: string;
}

/** Independently run PRF's live observation and canonical genesis preflight.
 * The result is bound to the exact bootstrap calldata before signing. */
export function verifyPrfGenesisSealPreflight(
  input: PrfGenesisSealPreflightInput,
  run: (command: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => { status: number | null; error?: Error; stdout?: string; stderr?: string } =
    (command, args, options) => spawnSync(command, args, options),
): PrfGenesisSealPreflightEvidence {
  const prfRoot = path.resolve(input.prfRoot);
  const files = [input.requestPath, input.trustedContextPath].map((file) => path.resolve(prfRoot, file));
  for (const file of files) {
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a regular file');
    } catch (error) {
      throw new ConfigError('PRF_GENESIS_SEAL_INPUT_INVALID', `Required PRF seal-preflight input is unavailable: ${path.relative(prfRoot, file)}`, {
        path: file, details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const args = ['-M:test', '-m', 'scripts.deployment.genesis-seal-gate', path.relative(prfRoot, files[0]!), path.relative(prfRoot, files[1]!), input.rpcUrl, input.genesisAddress, input.authorityAdapterAddress, '--json'];
  const result = run('clojure', args, { cwd: prfRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new ConfigError('PRF_GENESIS_SEAL_PREFLIGHT_REJECTED', 'PRF rejected live genesis-seal preflight or its verifier could not run', {
      details: { exitCode: result.status, error: result.error?.message, output: (result.stderr ?? result.stdout ?? '').slice(-4000) },
    });
  }
  const output = result.stdout ?? '';
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(output) as Record<string, unknown>; }
  catch { throw new ConfigError('PRF_GENESIS_SEAL_PREFLIGHT_INVALID_RESULT', 'PRF seal gate returned malformed structured output'); }
  const call = parsed['seal-call'] as Record<string, unknown> | undefined;
  const callArgs = Array.isArray(call?.args) ? call.args.map(String) : [];
  const expectedArgs = input.expectedCall.args.map((value) => value === undefined
    ? undefined
    : typeof value === 'string' ? value.replace(/^0x/, '').toLowerCase() : String(value));
  const sameCall = Boolean(call) &&
    String(call!.from).toLowerCase() === input.expectedCall.from.toLowerCase() &&
    String(call!.target).toLowerCase() === input.expectedCall.target.toLowerCase() &&
    call!.function === input.expectedCall.function &&
    callArgs.length === expectedArgs.length &&
    callArgs.every((value, index) => expectedArgs[index] === undefined || value.replace(/^0x/, '').toLowerCase() === expectedArgs[index]);
  if (parsed.schema !== 'prf-chain-instance-seal-preflight.v2' ||
      parsed.qualification !== 'approved-inputs-and-live-observations-verified' ||
      parsed['manifest-root'] !== input.expectedManifestRoot ||
      !sameCall || typeof parsed['computed-root'] !== 'string' || typeof parsed['source-tree-sha256'] !== 'string' ||
      typeof parsed['observations-edn'] !== 'string' || !Number.isInteger(parsed['source-file-count'])) {
    throw new ConfigError('PRF_GENESIS_SEAL_PREFLIGHT_INVALID_RESULT', 'PRF seal preflight does not match the approved manifest and exact planned bootstrap call', {
      details: { schema: parsed.schema, qualification: parsed.qualification, manifestRoot: parsed['manifest-root'], expectedManifestRoot: input.expectedManifestRoot, expectedCall: input.expectedCall, observedCall: call },
    });
  }
  const roles = ['preflight-request', 'trusted-context'];
  return {
    schema: 'prf-chain-instance-seal-preflight.v2',
    qualification: 'approved-inputs-and-live-observations-verified',
    manifestRoot: String(parsed['manifest-root']),
    sourceTreeSha256: String(parsed['source-tree-sha256']),
    computedRoot: String(parsed['computed-root']),
    sealCall: call as PrfGenesisSealPreflightEvidence['sealCall'],
    derivedArguments: callArgs.map((value) => `0x${value.replace(/^0x/, '')}`),
    observationBlocks: parsed['observation-blocks'],
    sourceFileCount: Number(parsed['source-file-count']),
    verifierCommand: ['clojure', ...args],
    inputs: files.map((file, index) => ({ role: roles[index]!, path: path.relative(prfRoot, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
    output,
    outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
  };
}

/** Independently verify the mined seal transaction and same-block post-state. */
export function verifyPrfGenesisSealResult(
  input: Omit<PrfGenesisSealPreflightInput, 'expectedCall'> & { transactionHash: string; expectedGenesisRoot: string; preflightOutput: string },
  run: (command: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => { status: number | null; error?: Error; stdout?: string; stderr?: string } =
    (command, args, options) => spawnSync(command, args, options),
): PrfGenesisSealResultEvidence {
  const prfRoot = path.resolve(input.prfRoot);
  const files = [input.requestPath, input.trustedContextPath].map((file) => path.resolve(prfRoot, file));
  for (const file of files) {
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a regular file');
    } catch (error) {
      throw new ConfigError('PRF_GENESIS_SEAL_INPUT_INVALID', `Required PRF seal-result input is unavailable: ${path.relative(prfRoot, file)}`, {
        path: file, details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-genesis-seal-result-'));
  const preflightPath = path.join(tempRoot, 'preflight.json');
  fs.writeFileSync(preflightPath, input.preflightOutput, { flag: 'wx', mode: 0o600 });
  const args = ['-M:test', '-m', 'scripts.deployment.genesis-seal-gate', 'verify-seal-result', path.relative(prfRoot, files[0]!), path.relative(prfRoot, files[1]!), preflightPath, input.rpcUrl, input.transactionHash, input.genesisAddress, input.authorityAdapterAddress, '--json'];
  let result: ReturnType<typeof run>;
  try { result = run('clojure', args, { cwd: prfRoot, encoding: 'utf8' }); }
  finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  if (result.error || result.status !== 0) {
    throw new ConfigError('PRF_GENESIS_SEAL_RESULT_REJECTED', 'PRF could not verify the mined seal receipt and same-block readback', {
      details: { exitCode: result.status, error: result.error?.message, output: (result.stderr ?? result.stdout ?? '').slice(-4000) },
    });
  }
  const output = result.stdout ?? '';
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(output) as Record<string, unknown>; }
  catch { throw new ConfigError('PRF_GENESIS_SEAL_RESULT_INVALID', 'PRF seal-result verifier returned malformed structured output'); }
  const root = parsed['chain-instance-genesis-root'];
  const manifestRoot = parsed['manifest-root'];
  if (parsed.schema !== 'prf-chain-instance-seal-result.v1' ||
      parsed.qualification !== 'seal-receipt-and-readback-verified' ||
      manifestRoot !== input.expectedManifestRoot || root !== input.expectedGenesisRoot) {
    throw new ConfigError('PRF_GENESIS_SEAL_RESULT_INVALID', 'PRF seal-result evidence does not match approved inputs or the preflight-derived root', {
      details: { schema: parsed.schema, qualification: parsed.qualification, manifestRoot, expectedManifestRoot: input.expectedManifestRoot, root, expectedGenesisRoot: input.expectedGenesisRoot },
    });
  }
  return {
    schema: 'prf-chain-instance-seal-result.v1',
    qualification: 'seal-receipt-and-readback-verified',
    manifestRoot: String(manifestRoot),
    chainInstanceGenesisRoot: String(root),
    receipt: parsed.receipt,
    preflightOutputSha256: createHash('sha256').update(input.preflightOutput, 'utf8').digest('hex'),
    verifierCommand: ['clojure', ...args],
    inputs: [
      ...files.map((file, index) => ({ role: index === 0 ? 'preflight-request' : 'trusted-context', path: path.relative(prfRoot, file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })),
      { role: 'preflight-verifier-output', path: 'captured-before-signing', sha256: createHash('sha256').update(input.preflightOutput, 'utf8').digest('hex') },
    ],
    output,
    outputSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
  };
}
