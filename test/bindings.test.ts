import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { resolveBindingValue, resolveBindingValueAsync, type BindingScope } from '../src/deployment/bindings';
import type { ResolvedBinding } from '../src/canonical';
import { ConfigError } from '../src/errors';
import { FakeTransport } from './fake-chain';

const CODE: Hex = ('0x' + '60'.repeat(64)) as Hex;

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

async function expectCodeAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

const address = '0x00000000000000000000000000000000000000aa' as const;

describe('binding value resolution', () => {
  it('resolves every kind that needs no chain read', () => {
    const scope: BindingScope = {
      parameters: new Map([['quorum', 50]]),
      addresses: { 'shared/timelock': address },
      externalAddresses: { treasury: address },
      deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    };
    expect(resolveBindingValue({ kind: 'literal', value: 'x' }, scope)).toBe('x');
    expect(resolveBindingValue({ kind: 'deployer' }, scope)).toBe(scope.deployer);
    expect(resolveBindingValue({ kind: 'contract-address', contract: 'shared/timelock' }, scope)).toBe(address);
    expect(resolveBindingValue({ kind: 'external-address', name: 'treasury' }, scope)).toBe(address);
    expect(resolveBindingValue({ kind: 'parameter', parameter: 'quorum' }, scope)).toBe(50);
    expect(resolveBindingValue({ kind: 'array', values: [{ kind: 'literal', value: 1 }, { kind: 'parameter', parameter: 'quorum' }] }, scope))
      .toEqual([1, 50]);
  });

  it('rejects an unresolved deployer, contract address and external address', () => {
    expectCode(() => resolveBindingValue({ kind: 'deployer' }, {}), 'UNRESOLVED_DEPLOYER');
    expectCode(() => resolveBindingValue({ kind: 'contract-address', contract: 'shared/timelock' }, {}), 'UNRESOLVED_CONTRACT_ADDRESS');
    // external-address is now resolvable; only a *missing* name fails, and with
    // the external-address-specific code rather than falling through.
    expectCode(() => resolveBindingValue({ kind: 'external-address', name: 'treasury' }, {}), 'UNKNOWN_EXTERNAL_ADDRESS');
  });

  it('refuses parameter bindings when the scope carries no parameters', () => {
    const binding: ResolvedBinding = { kind: 'parameter', parameter: 'quorum' };
    expectCode(() => resolveBindingValue(binding, { addresses: {} }), 'BOOTSTRAP_PARAMETER_UNSUPPORTED');
    expectCode(() => resolveBindingValue(binding, { addresses: {}, parameters: new Map() }), 'UNKNOWN_BINDING_PARAMETER');
  });

  it('refuses runtime-code-hash outside the async entry point', () => {
    expectCode(() => resolveBindingValue({ kind: 'runtime-code-hash', contract: 'shared/timelock' }, {}), 'RUNTIME_CODE_HASH_CONSTRUCTOR_UNSUPPORTED');
  });

  it('resolves runtime-code-hash by reading deployed code', async () => {
    const transport = new FakeTransport({ code: () => CODE });
    const value = await resolveBindingValueAsync(
      { kind: 'runtime-code-hash', contract: 'shared/timelock' },
      { addresses: { 'shared/timelock': address }, transport },
    );
    expect(value).toBe(keccak256(CODE));
  });

  it('fails closed on missing chain access, missing address and absent code', async () => {
    const binding: ResolvedBinding = { kind: 'runtime-code-hash', contract: 'shared/timelock' };
    await expectCodeAsync(() => resolveBindingValueAsync(binding, { addresses: { 'shared/timelock': address } }), 'RUNTIME_CODE_UNAVAILABLE');
    await expectCodeAsync(() => resolveBindingValueAsync(binding, { transport: new FakeTransport() }), 'UNRESOLVED_CONTRACT_ADDRESS');
    await expectCodeAsync(
      () => resolveBindingValueAsync(binding, { addresses: { 'shared/timelock': address }, transport: new FakeTransport({ code: () => '0x' }) }),
      'RUNTIME_CODE_UNAVAILABLE',
    );
  });

  it('delegates every non-runtime-code-hash kind to the shared resolver', async () => {
    const scope: BindingScope = { deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' };
    expect(await resolveBindingValueAsync({ kind: 'deployer' }, scope)).toBe(scope.deployer);
    expect(await resolveBindingValueAsync({ kind: 'array', values: [{ kind: 'literal', value: true }] }, scope)).toEqual([true]);
    await expectCodeAsync(() => resolveBindingValueAsync({ kind: 'parameter', parameter: 'quorum' }, scope), 'BOOTSTRAP_PARAMETER_UNSUPPORTED');
  });
});
