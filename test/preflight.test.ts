import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  assertSufficientBalance,
  preflightDeployment,
  DEFAULT_BALANCE_MARGIN_BPS,
  DEFAULT_BOOTSTRAP_GAS_BUDGET,
  DEFAULT_DEPLOY_GAS_BUDGET,
} from '../src/deployment/preflight';
import { ConfigError } from '../src/errors';
import { FakeTransport } from './fake-chain';

const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

// 2 deployments + 1 bootstrap, at a 2 gwei max fee, +20% margin.
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const REQUIRED = (2n * DEFAULT_DEPLOY_GAS_BUDGET + 1n * DEFAULT_BOOTSTRAP_GAS_BUDGET) * FEES.maxFeePerGas
  * (10_000n + DEFAULT_BALANCE_MARGIN_BPS) / 10_000n;

describe('deployment funding preflight', () => {
  it('reports a funded account as sufficient', async () => {
    const result = await preflightDeployment({
      transport: new FakeTransport({ balance: REQUIRED + 1n, fees: FEES }),
      deployer: DEPLOYER,
      deploymentSteps: 2,
      bootstrapActions: 1,
    });
    expect(result.chainId).toBe(31337);
    expect(result.requiredBalance).toBe(REQUIRED);
    expect(result.sufficient).toBe(true);
    expect(() => assertSufficientBalance(result)).not.toThrow();
  });

  it('fails closed on an underfunded account', async () => {
    const result = await preflightDeployment({
      transport: new FakeTransport({ balance: REQUIRED - 1n, fees: FEES }),
      deployer: DEPLOYER,
      deploymentSteps: 2,
      bootstrapActions: 1,
    });
    expect(result.sufficient).toBe(false);
    expectCode(() => assertSufficientBalance(result), 'INSUFFICIENT_BALANCE');
  });

  it('honours a fee override instead of the chain estimate', async () => {
    const transport = new FakeTransport({ balance: 10n ** 18n, fees: { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n } });
    const result = await preflightDeployment({
      transport,
      deployer: DEPLOYER,
      deploymentSteps: 1,
      bootstrapActions: 0,
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 7n },
    });
    expect(result.fees).toEqual({ maxFeePerGas: 100n, maxPriorityFeePerGas: 7n });
    expect(result.requiredBalance).toBe((DEFAULT_DEPLOY_GAS_BUDGET * 100n * 12_000n) / 10_000n);
  });
});
