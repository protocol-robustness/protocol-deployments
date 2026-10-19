import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { verifyPrfAuthorityTransition, type PrfAuthorityTransitionScope } from '../src/deployment/prf-authority-transition';

const scope: PrfAuthorityTransitionScope = {
  'chain-instance-genesis-root': `sha256:${'1'.repeat(64)}`,
  'adapter-address': `0x${'2'.repeat(40)}`,
  'previous-root': `sha256:${'3'.repeat(64)}`,
  'successor-root': `sha256:${'4'.repeat(64)}`,
  'policy-root': `sha256:${'5'.repeat(64)}`,
  'decision-root': `sha256:${'6'.repeat(64)}`,
  'transition-root': `sha256:${'7'.repeat(64)}`,
  'execution-commitment': `0x${'8'.repeat(64)}`,
  'previous-revision': 0,
  'successor-revision': 1,
};
const mutation = {
  kind: 0, decisionRoot: `0x${'6'.repeat(64)}`, targetMode: 0, targetRoot: `0x${'1'.repeat(64)}`,
  parentConfigurationRoot: `0x${'3'.repeat(64)}`, newConfigurationRoot: `0x${'4'.repeat(64)}`,
  parentVerifierRegistryRoot: `0x${'9'.repeat(64)}`, newVerifierRegistryRoot: `0x${'a'.repeat(64)}`,
  epoch: 1, proofMode: 0,
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-authority-transition-'));
  fs.writeFileSync(path.join(root, 'request.edn'), '{}\n');
  fs.writeFileSync(path.join(root, 'context.edn'), '{}\n');
  return { root, input: { prfRoot: root, requestPath: 'request.edn', trustedContextPath: 'context.edn' } };
}

function result(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    valid: true, qualification: 'authenticated-authority-transition',
    scope, 'decision-preimages-root': `0x${'b'.repeat(64)}`,
    'execution-mutation-root': `0x${'c'.repeat(64)}`, mutations: [mutation],
    attestation: `0x${'d'.repeat(130)}`, ...overrides,
  });
}

describe('PRF authority-transition verifier bridge', () => {
  it('retains verified mutation and attestation evidence under the exact scope', () => {
    const { root, input } = setup();
    try {
      const evidence = verifyPrfAuthorityTransition(input, scope, (_command, args, options) => {
        expect(args.slice(0, 4)).toEqual(['-M:test', '-m', 'scripts.deployment.authority-transition-review', 'verify-json']);
        expect(options.cwd).toBe(root);
        return { status: 0, stdout: result() };
      });
      expect(evidence.scope).toEqual(scope);
      expect(evidence.mutations).toEqual([mutation]);
      expect(evidence.attestation).toBe(`0x${'d'.repeat(130)}`);
      expect(evidence.inputs.map((entry) => entry.role)).toEqual(['transition-request', 'trusted-transition-context']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects verifier failure, altered scope and malformed mutation output', () => {
    const { root, input } = setup();
    try {
      expect(() => verifyPrfAuthorityTransition(input, scope, () => ({ status: 1, stderr: 'invalid signature' })))
        .toThrowError(expect.objectContaining({ code: 'PRF_AUTHORITY_TRANSITION_REJECTED' }));
      expect(() => verifyPrfAuthorityTransition(input, { ...scope, 'successor-root': `sha256:${'f'.repeat(64)}` },
        () => ({ status: 0, stdout: result() })))
        .toThrowError(expect.objectContaining({ code: 'PRF_AUTHORITY_TRANSITION_SCOPE_MISMATCH' }));
      expect(() => verifyPrfAuthorityTransition(input, scope,
        () => ({ status: 0, stdout: result({ mutations: [{ kind: 3 }] }) })))
        .toThrowError(expect.objectContaining({ code: 'PRF_AUTHORITY_TRANSITION_INVALID_RESULT' }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
