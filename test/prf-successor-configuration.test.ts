import { describe, expect, it } from 'vitest';
import { derivePrfSuccessorConfiguration } from '../src/deployment/prf-successor-configuration';

const root = (char: string) => `sha256:${char.repeat(64)}`;
const input = {
  prfRoot: '/tmp/prf',
  initialConfiguration: { 'configuration/schema': 'chain-configuration.v1' },
  protocolGenesisRoot: root('a'),
  chainInstanceGenesis: { 'genesis/schema': 'chain-instance-genesis.v1' },
  expectedChainInstanceGenesisRoot: root('b'),
  expectedInitialConfigurationRoot: root('c'),
  successorVerifierRegistryRoot: root('d'),
  successorProofMode: 1,
  epoch: 1,
};

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'prf-successor-configuration-derivation.v1',
    qualification: 'derived-only-not-approved',
    'configuration/C0-root': root('c'),
    'configuration/C1-root': root('e'),
    'chain-instance-genesis-root': root('b'),
    'successor-verifier-registry-root': root('d'),
    'successor-proof-mode': 1,
    'changed-fields': ['verifier-registry/root'],
    'configuration-transition': {
      'configuration/parent-root': root('c'), 'configuration/new-root': root('e'),
      'verifier-registry/root': root('d'), epoch: 1,
    },
    ...overrides,
  };
}

describe('PRF successor configuration derivation gate', () => {
  it('retains C0/C1 derivation only when the exact deployment inputs match', () => {
    const evidence = derivePrfSuccessorConfiguration(input, (_command, args, options) => {
      expect(args).toContain('derive-json');
      expect(options.cwd).toBe('/tmp/prf');
      return { status: 0, stdout: JSON.stringify(result()) };
    });
    expect(evidence.derivation['configuration/C0-root']).toBe(root('c'));
    expect(evidence.derivation['configuration/C1-root']).toBe(root('e'));
    expect(evidence.request['expected-initial-configuration-root']).toBe(root('c'));
    expect(evidence.qualification).toBe('successor-configuration-independently-derived-not-approved');
  });

  it('rejects a different instance, C0 parent, registry, epoch or changed field', () => {
    for (const output of [
      result({ 'chain-instance-genesis-root': root('f') }),
      result({ 'configuration/C0-root': root('f') }),
      result({ 'successor-verifier-registry-root': root('f') }),
      result({ 'changed-fields': ['governance-policy/root'] }),
      result({ 'configuration-transition': { ...result()['configuration-transition'], epoch: 2 } }),
    ]) {
      expect(() => derivePrfSuccessorConfiguration(input, () => ({ status: 0, stdout: JSON.stringify(output) })))
        .toThrowError(expect.objectContaining({ code: 'PRF_SUCCESSOR_CONFIGURATION_DERIVATION_MISMATCH' }));
    }
  });

  it('rejects malformed or independently rejected PRF output', () => {
    expect(() => derivePrfSuccessorConfiguration(input, () => ({ status: 1, stdout: '' })))
      .toThrowError(expect.objectContaining({ code: 'PRF_SUCCESSOR_CONFIGURATION_DERIVATION_REJECTED' }));
    expect(() => derivePrfSuccessorConfiguration(input, () => ({ status: 0, stdout: 'not-json' })))
      .toThrowError(expect.objectContaining({ code: 'PRF_SUCCESSOR_CONFIGURATION_DERIVATION_INVALID' }));
    expect(() => derivePrfSuccessorConfiguration(input, () => ({ status: 0, stdout: '{}' })))
      .toThrowError(expect.objectContaining({ code: 'PRF_SUCCESSOR_CONFIGURATION_DERIVATION_MISMATCH' }));
  });
});
