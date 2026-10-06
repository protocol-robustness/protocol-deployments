import { describe, expect, it } from 'vitest';
import { baseline, resolveEdn } from './helpers';
import { ConfigError } from '../src/errors';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

/** Add `:constructorBindings {...}` to a contract in the baseline architecture EDN. */
function withBindings(artifact: string, bindings: string): string {
  const marker = `:artifact "${artifact}"`;
  if (!baseline.architecture.includes(marker)) throw new Error(`baseline architecture lacks ${marker}`);
  return baseline.architecture.replace(marker, `${marker} :constructorBindings {${bindings}}`);
}

describe('constructor binding validation', () => {
  it('accepts an explicit binding for every ABI input', () => {
    const architecture = withBindings(
      'PrfVerifierRegistry',
      ':governor_ {:contractAddress :shared/governor}',
    );
    const { spec } = resolveEdn({ architecture });
    expect(spec.contracts['prf/verifier']?.constructorBindings?.governor_)
      .toEqual({ kind: 'contract-address', contract: 'shared/governor' });
  });

  it('rejects a binding that is not an ABI input', () => {
    const architecture = withBindings('PrfVerifierRegistry', ':notAnInput {:literal "x"}');
    expectCode(() => resolveEdn({ architecture }), 'UNKNOWN_CONSTRUCTOR_BINDING');
  });

  it('rejects a constructor that references a contract deployed after it', () => {
    const architecture = withBindings(
      'SewToken',
      ':name {:literal "G"} :symbol {:literal "G"} :initialOwner {:contractAddress :shared/governor} :initialSupply {:literal 100}',
    );
    // gov-token is deployed before the governor it depends on.
    expectCode(() => resolveEdn({ architecture }), 'CONSTRUCTOR_BINDING_ORDER');
  });

  it('rejects a constructor input with no binding at all', () => {
    const architecture = withBindings(
      'SewToken',
      ':name {:literal "G"} :symbol {:literal "G"}',
    );
    expectCode(() => resolveEdn({ architecture }), 'UNRESOLVED_CONSTRUCTOR_ARG');
  });
});
