import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { canonicalJson } from '../canonical-json';
import { ConfigError } from '../errors';
import type { DeploymentManifest } from './manifest';

type EvidenceAssertion = { id: string; status: string; detail?: string };
type CommandRunner = (command: string, args: string[], options: { cwd: string; encoding: 'utf8' }) => {
  status: number | null; error?: Error; stdout?: string; stderr?: string;
};

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const fail = (message: string): never => { throw new ConfigError('PLAN_EXECUTION_PRF_EVIDENCE_MISMATCH', message); };

function parseEvidence(assertion: EvidenceAssertion | undefined, id: string): Record<string, unknown> {
  if (!assertion || assertion.status !== 'passed' || !assertion.detail) return fail(`Required PRF assertion '${id}' is absent or not passed`);
  try { return JSON.parse(assertion.detail) as Record<string, unknown>; }
  catch { return fail(`Retained PRF assertion '${id}' is not valid JSON`); }
}

function retainedFiles(root: string, trustedContextRoot: string, evidence: Record<string, unknown>, expectedRoles: string[]): string[] {
  const inputs = evidence.inputs as Array<{ role?: unknown; path?: unknown; sha256?: unknown }> | undefined;
  if (!Array.isArray(inputs) || inputs.length !== expectedRoles.length) return fail('Retained PRF evidence has an incomplete input list');
  const files: string[] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i]!;
    if (input.role !== expectedRoles[i] || typeof input.path !== 'string' || typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) {
      return fail(`Retained PRF evidence input ${i} has a missing or unexpected role, path, or digest`);
    }
    const relative = path.normalize(input.path);
    const isTrustedContext = ['trusted-context', 'trusted-transition-context', 'approval-envelope', 'preflight-request'].includes(String(input.role));
    if (path.isAbsolute(relative) || relative === '.') return fail('Retained PRF evidence input escapes its source root');
    // Approval artifacts may be held outside the source checkout. Resolve
    // retained paths against the checkout first, then accept them only when
    // their real file is contained by the separately supplied trusted root.
    const sourceCandidate = { base: root, file: path.resolve(root, relative), returnAbsolute: false };
    const trustedCandidates = [
      { base: trustedContextRoot, file: path.resolve(root, relative), returnAbsolute: true },
      { base: trustedContextRoot, file: path.resolve(trustedContextRoot, relative), returnAbsolute: true },
    ];
    const candidates = isTrustedContext ? [...trustedCandidates, sourceCandidate] : [sourceCandidate, ...trustedCandidates];
    const selected = candidates.find(({ base, file }) => {
      const candidateRelative = path.relative(base, file);
      return Boolean(candidateRelative) && candidateRelative !== '..' &&
        !candidateRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(candidateRelative) && fs.existsSync(file);
    });
    if (!selected) return fail('Retained PRF evidence input is unavailable under the source or trusted-context root');
    const { base, file, returnAbsolute } = selected;
    const contained = path.relative(base, file);
    if (!contained || contained.startsWith(`..${path.sep}`) || contained === '..' || path.isAbsolute(contained)) return fail('Retained PRF evidence input escapes its source root');
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return fail(`Retained PRF input '${input.path}' is unavailable`); }
    let realBase: string;
    let realFile: string;
    try { realBase = fs.realpathSync(base); realFile = fs.realpathSync(file); }
    catch { return fail(`Retained PRF input '${input.path}' cannot be resolved safely`); }
    const realRelative = path.relative(realBase, realFile);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative) ||
        !stat.isFile() || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== input.sha256) {
      return fail(`Retained PRF input '${input.path}' does not match its authenticated digest`);
    }
    files.push(returnAbsolute ? file : relative);
  }
  return files;
}

function invoke(root: string, args: string[], expectedOutput: unknown, run: CommandRunner): void {
  const result = run('clojure', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) return fail(`Independent PRF replay failed: ${(result.stderr ?? result.stdout ?? result.error?.message ?? '').slice(-2000)}`);
  let observed: unknown;
  try { observed = JSON.parse(result.stdout ?? ''); } catch { return fail('Independent PRF replay returned malformed JSON'); }
  if (canonicalJson(observed) !== canonicalJson(expectedOutput)) return fail('Independent PRF replay output differs from retained evidence');
}

/** Re-run deterministic PRF approval and root derivations from retained inputs. */
export function replayRetainedPrfEvidence(
  manifest: DeploymentManifest,
  prfRoot: string,
  trustedContextRoot: string,
  rpcUrl?: string,
  run: CommandRunner = (command, args, options) => spawnSync(command, args, options),
): number {
  const root = path.resolve(prfRoot);
  const trustedRoot = path.resolve(trustedContextRoot);
  try { if (!fs.statSync(trustedRoot).isDirectory()) return fail('Trusted-context root is not a directory'); }
  catch { return fail('Trusted-context root is unavailable'); }
  const assertions = manifest.finalAssertions as EvidenceAssertion[];
  const byId = (id: string): EvidenceAssertion | undefined => assertions.find((assertion) => assertion.id === id && assertion.status === 'passed');
  let replayed = 0;

  const replayFileVerifier = (id: string, roles: string[], namespace: string, mode: string, required = false) => {
    const assertion = byId(id);
    if (!assertion && !required) return;
    const evidence = parseEvidence(assertion, id);
    const output = evidence.output;
    if (typeof output !== 'string' || evidence.outputSha256 !== digest(output)) return fail(`Retained PRF output digest for '${id}' is invalid`);
    const files = retainedFiles(root, trustedRoot, evidence, roles);
    const parsedOutput = (() => { try { return JSON.parse(output) as unknown; } catch { return fail(`Retained PRF output for '${id}' is malformed`); } })();
    invoke(root, ['-M:test', '-m', namespace, mode, ...files], parsedOutput, run);
    replayed += 1;
  };

  replayFileVerifier('prf-initial-input-approval', ['manifest', 'package-set', 'trusted-context', 'approval-envelope'],
    'scripts.deployment.configuration-review', 'verify-json', true);
  if (byId('prf-successor-transition-approval')) {
    replayFileVerifier('prf-successor-transition-approval', ['transition-manifest', 'verifier-registry', 'trusted-context', 'approval-envelope'],
      'scripts.deployment.successor-transition-review', 'verify-json');
  }
  if (byId('prf-authority-transition-verification')) {
    replayFileVerifier('prf-authority-transition-verification', ['transition-request', 'trusted-transition-context'],
      'scripts.deployment.authority-transition-review', 'verify-json');
  }

  const replayRequest = (id: string, namespace: string, mode: string, request: unknown, output: unknown) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-evidence-replay-'));
    const requestPath = path.join(temp, 'request.json');
    try {
      fs.writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
      const evidence = parseEvidence(byId(id), id);
      if (typeof evidence.output !== 'string' || evidence.outputSha256 !== digest(evidence.output) ||
          canonicalJson(JSON.parse(evidence.output)) !== canonicalJson(output)) return fail(`Retained PRF output for '${id}' is inconsistent`);
      invoke(root, ['-M:test', '-m', namespace, mode, requestPath], output, run);
      replayed += 1;
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  };

  if (byId('prf-successor-registry-derivation')) {
    const registry = parseEvidence(byId('prf-successor-registry-derivation'), 'prf-successor-registry-derivation');
    let registryOutput: unknown;
    try { registryOutput = typeof registry.output === 'string' ? JSON.parse(registry.output) as unknown : undefined; }
    catch { return fail('Retained successor-registry derivation output is malformed'); }
    const registryEntry = registry.entry;
    if (!registryEntry || typeof registry.root !== 'string' || registry.solidityRoot !== registry.root ||
        typeof registry.output !== 'string' || registry.outputSha256 !== digest(registry.output) ||
        registry.requestSha256 !== digest(JSON.stringify({ schema: 'prf-verifier-registry-derivation-request.v1', entries: [registryEntry] }))) {
      return fail('Retained successor-registry derivation request or output digest is invalid');
    }
    replayRequest('prf-successor-registry-derivation', 'scripts.deployment.registry-equivalence', 'derive-json',
      { schema: 'prf-verifier-registry-derivation-request.v1', entries: [registryEntry] }, registryOutput);
  }

  if (byId('prf-successor-configuration-derivation')) {
    const successor = parseEvidence(byId('prf-successor-configuration-derivation'), 'prf-successor-configuration-derivation');
    const request = successor.request;
    const derivation = successor.derivation;
    if (!request || typeof request !== 'object' || !derivation || typeof derivation !== 'object' ||
        successor.requestSha256 !== digest(JSON.stringify(request)) || successor.outputSha256 !== digest(String(successor.output))) {
      return fail('Retained C0 to C1 derivation request or output digest is invalid');
    }
    replayRequest('prf-successor-configuration-derivation', 'scripts.deployment.successor-configuration', 'derive-json', request, derivation);
  }

  if (byId('prf-genesis-seal-result')) {
    if (!rpcUrl) return fail('Genesis seal evidence requires --rpc-url for independent receipt and historical readback verification');
    const preflight = parseEvidence(byId('prf-genesis-seal-preflight'), 'prf-genesis-seal-preflight');
    const resultEvidence = parseEvidence(byId('prf-genesis-seal-result'), 'prf-genesis-seal-result');
    const preflightOutput = preflight.output;
    const resultOutput = resultEvidence.output;
    if (typeof preflightOutput !== 'string' || preflight.outputSha256 !== digest(preflightOutput) ||
        typeof resultOutput !== 'string' || resultEvidence.outputSha256 !== digest(resultOutput)) {
      return fail('Retained genesis preflight or seal-result output digest is invalid');
    }
    const inputs = resultEvidence.inputs as Array<{ role?: unknown; path?: unknown; sha256?: unknown }> | undefined;
    if (!Array.isArray(inputs) || inputs.length !== 3 || inputs[2]?.role !== 'preflight-verifier-output' ||
        inputs[2]?.path !== 'captured-before-signing' || inputs[2]?.sha256 !== digest(preflightOutput)) {
      return fail('Genesis seal-result evidence is not bound to its retained preflight output');
    }
    const fileInputs = { ...resultEvidence, inputs: inputs.slice(0, 2) };
    const files = retainedFiles(root, trustedRoot, fileInputs, ['preflight-request', 'trusted-context']);
    const genesis = manifest.contracts.find((contract) => contract.logicalId === 'prf/genesis');
    const authority = manifest.contracts.find((contract) => contract.logicalId === 'prf/governance-authority');
    const action = manifest.bootstrapActions.find((candidate) => candidate.id === 'prf/seal-genesis' && candidate.status === 'verified');
    if (!genesis || !authority || !action?.transactionHash) return fail('Genesis seal result lacks its manifested contracts or verified seal action');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-seal-result-replay-'));
    const preflightPath = path.join(temp, 'preflight.json');
    try {
      fs.writeFileSync(preflightPath, preflightOutput, { flag: 'wx', mode: 0o600 });
      const args = ['-M:test', '-m', 'scripts.deployment.genesis-seal-gate', 'verify-seal-result',
        files[0]!, files[1]!, preflightPath, rpcUrl, action.transactionHash, genesis.address, authority.address, '--json'];
      invoke(root, args, JSON.parse(resultOutput) as unknown, run);
      replayed += 1;
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return replayed;
}
