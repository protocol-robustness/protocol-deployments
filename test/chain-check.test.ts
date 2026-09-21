import { describe, it, expect } from 'vitest';
import { assertChainIdMatches } from '../src/validate/checks';
import { ConfigError } from '../src/errors';

describe('chain id validation', () => {
  it('accepts matching chain ids', () => {
    expect(() => assertChainIdMatches({ chainId: 31337, environment: 'local' }, 31337)).not.toThrow();
  });

  it('rejects configured != connected chain id', () => {
    try {
      assertChainIdMatches({ chainId: 84532, environment: 'base-sepolia' }, 31337);
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('CHAIN_ID_MISMATCH');
    }
  });

  it('rejects missing connected chain id', () => {
    try {
      assertChainIdMatches({ chainId: 31337, environment: 'local' }, null);
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('CHAIN_ID_MISMATCH');
    }
  });

  it('rejects invalid configured chain id', () => {
    try {
      assertChainIdMatches({ chainId: 0, environment: 'local' }, 0);
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('UNRESOLVED_CHAIN_BINDING');
    }
  });
});
