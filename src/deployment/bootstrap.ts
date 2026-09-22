import { decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Address, type Hex } from 'viem';
import type { ResolvedBinding, ResolvedContract } from '../canonical';
import type { RpcTransport } from '../runtime/transport';
import type { Signer } from '../runtime/signer';
import { ConfigError } from '../errors';

async function value(binding: ResolvedBinding, addresses: Record<string, Address>, deployer: Address, transport: RpcTransport): Promise<unknown> {
  switch (binding.kind) {
    case 'literal': return binding.value;
    case 'deployer': return deployer;
    case 'contract-address': {
      const address = addresses[binding.contract];
      if (!address) throw new ConfigError('UNRESOLVED_CONTRACT_ADDRESS', `Bootstrap binding '${binding.contract}' is unavailable`);
      return address;
    }
    case 'runtime-code-hash': {
      const address = addresses[binding.contract];
      if (!address) throw new ConfigError('UNRESOLVED_CONTRACT_ADDRESS', `Runtime code hash binding '${binding.contract}' is unavailable`);
      const code = await transport.getCode(address);
      if (!code || code === '0x') throw new ConfigError('RUNTIME_CODE_UNAVAILABLE', `No runtime code found for '${binding.contract}'`);
      return keccak256(code);
    }
    case 'external-address': throw new ConfigError('UNKNOWN_EXTERNAL_ADDRESS', `Bootstrap external address '${binding.name}' was not materialized`);
    case 'parameter': throw new ConfigError('BOOTSTRAP_PARAMETER_UNSUPPORTED', `Bootstrap parameter binding '${binding.parameter}' requires explicit literal materialization`);
    case 'array': return Promise.all(binding.values.map((item) => value(item, addresses, deployer, transport)));
  }
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
  transport: RpcTransport;
  signer: Signer;
  onTransition?: (transition: { status: 'submitted' | 'confirmed'; transactionHash: Hex; blockNumber?: bigint }) => Promise<void> | void;
}): Promise<{ transactionHash: Hex; blockNumber: bigint }> {
  const deployer = await input.signer.getAddress();
  const abi = [abiFunction(input.contract, input.function)] as unknown as Abi;
  const args = await Promise.all(input.args.map((arg) => value(arg, input.addresses, deployer, input.transport)));
  const data = encodeFunctionData({ abi, functionName: input.function, args });
  const chainId = await input.transport.getChainId();
  const nonce = await input.transport.getTransactionCount(deployer);
  const gas = (await input.transport.estimateGas({ from: deployer, to: input.address, data })) + 30000n;
  const raw = await input.signer.signTransaction({ chainId, to: input.address, data, nonce, gas, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n });
  const transactionHash = await input.transport.sendRawTransaction(raw);
  await input.onTransition?.({ status: 'submitted', transactionHash });
  for (let i = 0; i < 60; i++) {
    const receipt = await input.transport.getTransactionReceipt(transactionHash);
    if (receipt) {
      if (receipt.status !== 'success') throw new ConfigError('BOOTSTRAP_REVERTED', `Bootstrap action '${input.function}' reverted`);
      await input.onTransition?.({ status: 'confirmed', transactionHash, blockNumber: receipt.blockNumber });
      return { transactionHash, blockNumber: receipt.blockNumber };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new ConfigError('BOOTSTRAP_RECEIPT_TIMEOUT', `Bootstrap action '${input.function}' receipt timed out`);
}

/** Read-only final bootstrap assertion against the pinned ABI. */
export async function assertBootstrap(input: {
  contract: ResolvedContract;
  address: Address;
  function: string;
  args: ResolvedBinding[];
  expected: string | number | boolean | ResolvedBinding;
  addresses: Record<string, Address>;
  transport: RpcTransport;
  signer: Signer;
}): Promise<void> {
  const deployer = await input.signer.getAddress();
  const entry = abiFunction(input.contract, input.function);
  const abi = [entry] as unknown as Abi;
  const args = await Promise.all(input.args.map((arg) => value(arg, input.addresses, deployer, input.transport)));
  const data = encodeFunctionData({ abi, functionName: input.function, args });
  const result = await input.transport.call({ to: input.address, data });
  const actual = decodeFunctionResult({ abi, functionName: input.function, data: result });
  const expected = typeof input.expected === 'object'
    ? await value(input.expected, input.addresses, deployer, input.transport)
    : input.expected;
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new ConfigError('BOOTSTRAP_ASSERTION_FAILED', `Bootstrap assertion '${input.function}' on '${input.contract.logicalId}' failed`, { details: { expected: String(expected), actual: String(actual) } });
  }
}
