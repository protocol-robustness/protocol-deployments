import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import type { ResolvedBinding, ResolvedContract } from '../canonical';
import type { RpcTransport, TxFees } from '../runtime/transport';
import type { Signer } from '../runtime/signer';
import { ConfigError } from '../errors';
import { resolveBindingValueAsync, type BindingScope } from './bindings';
import { DEFAULT_RECEIPT_TIMEOUT_MS } from './engine';

function bindingScope(input: {
  addresses: Record<string, Address>;
  externalAddresses?: Record<string, Address>;
  transport: RpcTransport;
  deployer: Address;
}): BindingScope {
  return {
    addresses: input.addresses,
    externalAddresses: input.externalAddresses,
    transport: input.transport,
    deployer: input.deployer,
  };
}

function abiFunction(contract: ResolvedContract, name: string) {
  const entry = (contract.artifact.abi as Array<{ type?: string; name?: string }>).find((item) => item.type === 'function' && item.name === name);
  if (!entry) throw new ConfigError('UNKNOWN_BOOTSTRAP_FUNCTION', `Function '${name}' is not in ${contract.logicalId}'s pinned ABI`);
  return entry as Abi[number];
}

/** Execute one declared initialization/bootstrap call; never used for later governance changes. */
export async function executeBootstrapAction(input: {
  contract: ResolvedContract;
  address: Address;
  function: string;
  args: ResolvedBinding[];
  addresses: Record<string, Address>;
  externalAddresses?: Record<string, Address>;
  transport: RpcTransport;
  signer: Signer;
  /** Override the live EIP-1559 fees (otherwise read from the chain). */
  fees?: TxFees;
  /** Override the receipt wait timeout in milliseconds. */
  receiptTimeoutMs?: number;
  onTransition?: (transition: { status: 'submitted' | 'confirmed'; transactionHash: Hex; blockNumber?: bigint }) => Promise<void> | void;
}): Promise<{ transactionHash: Hex; blockNumber: bigint }> {
  const deployer = await input.signer.getAddress();
  const scope = bindingScope({ addresses: input.addresses, externalAddresses: input.externalAddresses, transport: input.transport, deployer });
  const abi = [abiFunction(input.contract, input.function)] as unknown as Abi;
  const args = await Promise.all(input.args.map((arg) => resolveBindingValueAsync(arg, scope)));
  const data = encodeFunctionData({ abi, functionName: input.function, args });
  const chainId = await input.transport.getChainId();
  const nonce = await input.transport.getTransactionCount(deployer);
  const gas = (await input.transport.estimateGas({ from: deployer, to: input.address, data })) + 30000n;
  const fees = input.fees ?? (await input.transport.estimateFeesPerGas());
  const raw = await input.signer.signTransaction({ chainId, to: input.address, data, nonce, gas, ...fees });
  const transactionHash = await input.transport.sendRawTransaction(raw);
  await input.onTransition?.({ status: 'submitted', transactionHash });
  const timeoutMs = input.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await input.transport.getTransactionReceipt(transactionHash);
    if (receipt) {
      if (receipt.status !== 'success') throw new ConfigError('BOOTSTRAP_REVERTED', `Bootstrap action '${input.function}' reverted`);
      await input.onTransition?.({ status: 'confirmed', transactionHash, blockNumber: receipt.blockNumber });
      return { transactionHash, blockNumber: receipt.blockNumber };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ConfigError('BOOTSTRAP_RECEIPT_TIMEOUT', `Bootstrap action '${input.function}' receipt timed out after ${timeoutMs}ms`);
}

/** Read-only final bootstrap assertion against the pinned ABI. */
export async function assertBootstrap(input: {
  contract: ResolvedContract;
  address: Address;
  function: string;
  args: ResolvedBinding[];
  expected: string | number | boolean | ResolvedBinding;
  addresses: Record<string, Address>;
  externalAddresses?: Record<string, Address>;
  transport: RpcTransport;
  signer: Signer;
}): Promise<void> {
  const deployer = await input.signer.getAddress();
  const scope = bindingScope({ addresses: input.addresses, externalAddresses: input.externalAddresses, transport: input.transport, deployer });
  const entry = abiFunction(input.contract, input.function);
  const abi = [entry] as unknown as Abi;
  const args = await Promise.all(input.args.map((arg) => resolveBindingValueAsync(arg, scope)));
  const data = encodeFunctionData({ abi, functionName: input.function, args });
  const result = await input.transport.call({ to: input.address, data });
  const actual = decodeFunctionResult({ abi, functionName: input.function, data: result });
  const expected = typeof input.expected === 'object'
    ? await resolveBindingValueAsync(input.expected, scope)
    : input.expected;
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new ConfigError('BOOTSTRAP_ASSERTION_FAILED', `Bootstrap assertion '${input.function}' on '${input.contract.logicalId}' failed`, { details: { expected: String(expected), actual: String(actual) } });
  }
}
