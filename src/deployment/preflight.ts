import type { Address } from 'viem';
import { ConfigError } from '../errors';
import type { RpcTransport, TxFees } from '../runtime/transport';

/**
 * Conservative gas budgets used only for the funding preflight. Exact
 * per-transaction gas is estimated by the engine immediately before signing;
 * this is a coarse "is the account funded at all" gate that runs before the
 * first transaction so a run does not fail halfway through on an empty account.
 */
export const DEFAULT_DEPLOY_GAS_BUDGET = 3_000_000n;
export const DEFAULT_BOOTSTRAP_GAS_BUDGET = 150_000n;
/** Required balance over the worst-case gas cost, in basis points (+20%). */
export const DEFAULT_BALANCE_MARGIN_BPS = 2_000n;

export interface PreflightInput {
  transport: RpcTransport;
  deployer: Address;
  /** Number of contract deployments in the plan. */
  deploymentSteps: number;
  /** Number of bootstrap actions in the plan. */
  bootstrapActions: number;
  /** Override the live EIP-1559 fees (otherwise read from the chain). */
  fees?: TxFees;
  deployGasBudget?: bigint;
  bootstrapGasBudget?: bigint;
  marginBps?: bigint;
}

export interface PreflightResult {
  chainId: number;
  deployer: Address;
  balance: bigint;
  fees: TxFees;
  /** Worst-case gas across deployments and bootstrap actions. */
  gasBudget: bigint;
  /** Balance required to cover `gasBudget` at the current max fee plus margin. */
  requiredBalance: bigint;
  sufficient: boolean;
}

/** Read chain, signer balance and fees and decide whether the run can be funded. */
export async function preflightDeployment(input: PreflightInput): Promise<PreflightResult> {
  const chainId = await input.transport.getChainId();
  const fees = input.fees ?? (await input.transport.estimateFeesPerGas());
  const balance = await input.transport.getBalance(input.deployer);
  const deployGas = input.deployGasBudget ?? DEFAULT_DEPLOY_GAS_BUDGET;
  const bootstrapGas = input.bootstrapGasBudget ?? DEFAULT_BOOTSTRAP_GAS_BUDGET;
  const gasBudget = BigInt(input.deploymentSteps) * deployGas + BigInt(input.bootstrapActions) * bootstrapGas;
  const marginBps = input.marginBps ?? DEFAULT_BALANCE_MARGIN_BPS;
  const requiredBalance = (gasBudget * fees.maxFeePerGas * (10_000n + marginBps)) / 10_000n;
  return {
    chainId,
    deployer: input.deployer,
    balance,
    fees,
    gasBudget,
    requiredBalance,
    sufficient: balance >= requiredBalance,
  };
}

/** Fail closed before the first transaction when the deployer cannot fund the plan. */
export function assertSufficientBalance(result: PreflightResult): void {
  if (result.sufficient) return;
  throw new ConfigError(
    'INSUFFICIENT_BALANCE',
    `Deployer ${result.deployer} holds ${result.balance} wei but this run needs about ${result.requiredBalance} wei; fund the account first`,
    { details: { balance: result.balance.toString(), required: result.requiredBalance.toString() } },
  );
}
