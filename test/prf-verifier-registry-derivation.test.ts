import { describe, expect, it } from 'vitest';
import { derivePrfVerifierRegistryRoot } from '../src/deployment/prf-verifier-registry-derivation';

const entry = {
  id: `0x${'01'.repeat(32)}`,
  adapter: '0x00000000000000000000000000000000000000a1',
  programVKey: `0x${'02'.repeat(32)}`,
  programElfSha256: `0x${'03'.repeat(32)}`,
  programId: 'source-bound-entitlement-sp1-program.v1',
  statementSchemaVersionHash: `0x${'04'.repeat(32)}`,
  publicValuesSchema: `0x${'05'.repeat(32)}`,
  active: true,
};
const root = '0xd54c9e5d18fa33ec45ca13f6eca6113a9ee5b07b6e1f37c440ab3343450fe949';

describe('PRF successor verifier-registry derivation', () => {
  it('retains the PRF derivation and requires equality with the Solidity root at a pinned block', () => {
    const output = JSON.stringify({ schema: 'prf-verifier-registry-derivation-result.v1', root, entries: [entry] });
    const evidence = derivePrfVerifierRegistryRoot({
      prfRoot: '/tmp/prf', entry, observationBlock: { number: 123n, hash: `0x${'aa'.repeat(32)}` }, solidityRoot: root,
    }, (_command, args, options) => {
      expect(args.slice(0, 4)).toEqual(['-M:test', '-m', 'scripts.deployment.registry-equivalence', 'derive-json']);
      expect(options.cwd).toBe('/tmp/prf');
      return { status: 0, stdout: output };
    });
    expect(evidence.root).toBe(root);
    expect(evidence.observationBlock).toEqual({ number: '123', hash: `0x${'aa'.repeat(32)}` });
    expect(evidence.entry).toEqual(entry);
    expect(evidence.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects PRF/Solidity root disagreement', () => {
    const output = JSON.stringify({ schema: 'prf-verifier-registry-derivation-result.v1', root, entries: [entry] });
    expect(() => derivePrfVerifierRegistryRoot({
      prfRoot: '/tmp/prf', entry, observationBlock: { number: 123n, hash: `0x${'aa'.repeat(32)}` }, solidityRoot: `0x${'bb'.repeat(32)}`,
    }, () => ({ status: 0, stdout: output }))).toThrowError(expect.objectContaining({ code: 'PRF_VERIFIER_REGISTRY_DERIVATION_MISMATCH' }));
  });
});
