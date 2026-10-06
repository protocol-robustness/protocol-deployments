import { describe, expect, it } from 'vitest';
import type { ResolvedBindingValue } from '../src/deployment/bindings';
import { convertArg, deployContract } from '../src/deployment/engine';
import { ConfigError } from '../src/errors';
import { FakeTransport, fakeSigner, recordingSigner } from './fake-chain';
import { baseline, bundle, resolveEdn } from './helpers';

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

/** Bind every SewToken constructor input so deployment reaches the receipt path. */
function boundSpec() {
  const marker = ':artifact "SewToken"';
  const architecture = baseline.architecture.replace(
    marker,
    `${marker} :constructorBindings {:name {:literal "G"} :symbol {:literal "G"} :initialOwner {:deployer true} :initialSupply {:literal 100}}`,
  );
  return resolveEdn({ architecture }).spec;
}

describe('deployment engine failure modes', () => {
  it('rejects a binding value whose shape does not match the ABI type', () => {
    expectCode(() => convertArg('not-an-array' as ResolvedBindingValue, 'address[]'), 'ABI_BINDING_TYPE_MISMATCH');
    expectCode(() => convertArg(false as ResolvedBindingValue, 'address[]'), 'ABI_BINDING_TYPE_MISMATCH');
  });

  it('reports a reverted deployment', async () => {
    await expectCodeAsync(
      () => deployContract({
        spec: boundSpec(),
        logicalId: 'shared/gov-token',
        bundle: bundle(),
        transport: new FakeTransport({ receipt: { status: 'reverted', blockNumber: 5n } as never }),
        signer: fakeSigner(),
      }),
      'DEPLOY_REVERTED',
    );
  });

  it('reports a successful receipt with no contract address', async () => {
    await expectCodeAsync(
      () => deployContract({
        spec: boundSpec(),
        logicalId: 'shared/gov-token',
        bundle: bundle(),
        transport: new FakeTransport({ receipt: { status: 'success', blockNumber: 5n } as never }),
        signer: fakeSigner(),
      }),
      'DEPLOY_NO_ADDRESS',
    );
  });

  it('gives up with a timeout code when no receipt ever arrives', async () => {
    await expectCodeAsync(
      () => deployContract({
        spec: boundSpec(),
        logicalId: 'shared/gov-token',
        bundle: bundle(),
        transport: new FakeTransport({ receipt: null }),
        signer: fakeSigner(),
        receiptTimeoutMs: 40,
      }),
      'DEPLOY_RECEIPT_TIMEOUT',
    );
  });

  it('signs with live fees when no override is given and the override otherwise', async () => {
    const live = recordingSigner();
    await deployContract({
      spec: boundSpec(),
      logicalId: 'shared/gov-token',
      bundle: bundle(),
      transport: new FakeTransport({ fees: { maxFeePerGas: 7n, maxPriorityFeePerGas: 3n }, receipt: { status: 'success', blockNumber: 5n } as never }),
      signer: live.signer,
    }).catch(() => undefined);
    expect(live.transactions[0]?.maxFeePerGas).toBe(7n);
    expect(live.transactions[0]?.maxPriorityFeePerGas).toBe(3n);

    const overridden = recordingSigner();
    await deployContract({
      spec: boundSpec(),
      logicalId: 'shared/gov-token',
      bundle: bundle(),
      transport: new FakeTransport({ fees: { maxFeePerGas: 7n, maxPriorityFeePerGas: 3n }, receipt: { status: 'success', blockNumber: 5n } as never }),
      signer: overridden.signer,
      fees: { maxFeePerGas: 99n, maxPriorityFeePerGas: 42n },
    }).catch(() => undefined);
    expect(overridden.transactions[0]?.maxFeePerGas).toBe(99n);
    expect(overridden.transactions[0]?.maxPriorityFeePerGas).toBe(42n);
  });
});
