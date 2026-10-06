import {
  encodeDeployData,

  type Address,
  type Hex,
  type Abi,
  type TransactionReceipt,
} from 'viem';
import { ConfigError } from '../errors';
import type { BundleConsumer } from '../artifacts/bundle';
import type { RpcTransport, TxFees } from '../runtime/transport';
import type { Signer } from '../runtime/signer';
import type { ResolvedSpec, ResolvedContract, ResolvedParameter } from '../canonical';
import { assertChainIdMatches } from '../validate/checks';
import { normalizeBytecode } from '../artifacts/hash';
import { resolveBindingValue, type BindingScope, type ResolvedBindingValue } from './bindings';

export type DeploymentMode = 'create' | 'create2';

/**
 * How long to wait for a transaction receipt before giving up. The default is
 * sized for a live testnet, not a local Anvil block, and is overridable per run.
 */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 180_000;

interface ConstructorInput {
  name?: string;
  type: string;
}
interface ConstructorLike {
  type: 'constructor';
  inputs: ConstructorInput[];
}

export interface DeployContractInput {
  spec: ResolvedSpec;
  logicalId: string;
  bundle: BundleConsumer;
  transport: RpcTransport;
  signer: Signer;
  mode?: DeploymentMode;
  /** Addresses confirmed by earlier deployment steps, keyed by logical ID. */
  resolvedAddresses?: Record<string, Address>;
  /** Materialized environment address bindings. */
  externalAddresses?: Record<string, Address>;
  /** Override the live EIP-1559 fees (otherwise read from the chain). */
  fees?: TxFees;
  /** Override the receipt wait timeout in milliseconds. */
  receiptTimeoutMs?: number;
  /** Called synchronously at durable transaction boundaries by the ledger owner. */
  onTransition?: (transition: { status: 'submitted' | 'confirmed' | 'verified'; transactionHash: Hex; blockNumber?: bigint; address?: Address }) => Promise<void> | void;
}

export interface DeployContractResult {
  logicalId: string;
  artifactName: string;
  address: Address;
  transactionHash: Hex;
  blockNumber: bigint;
  mode: DeploymentMode;
  /** Resolved parameter values applied at deployment (immutable deployment fact). */
  deployedParameters: Record<string, string | number | boolean>;
}

/**
 * Deploys a single logical contract from the frozen resolved spec:
 *
 *   load artifact → verify identity/hashes → resolve constructor args
 *   → encode init code → derive/validate expected address (CREATE2)
 *   → read chain id → read signer nonce → construct unsigned tx
 *   → estimate/determine gas → sign → eth_sendRawTransaction
 *   → wait receipt → verify success → eth_getCode
 *   → verify deployed runtime bytecode → return deployment fact
 *
 * Deployment is deliberately serial and nonce-boring (one tx, wait, next).
 * No parallel deployments, no speculative nonces, no tx replacement.
 */
export async function deployContract(input: DeployContractInput): Promise<DeployContractResult> {
  const { spec, logicalId, bundle, transport, signer } = input;
  const mode: DeploymentMode = input.mode ?? 'create';
  if (mode === 'create2') {
    throw new ConfigError(
      'CREATE2_UNSUPPORTED',
      'CREATE2 is disabled until a concrete, verified factory deployment protocol is implemented',
    );
  }

  const contract = spec.contracts[logicalId];
  if (!contract) throw new ConfigError('UNKNOWN_LOGICAL_CONTRACT', `Unknown logical contract '${logicalId}'`);

  // --- load artifact and verify identity/hashes (from the pinned bundle) ---
  const loaded = bundle.loadArtifact(
    contract.artifactSource,
    contract.artifact.package,
    contract.artifact.version,
    contract.artifactName,
  );
  const artifact = loaded.artifact;
  const creationBytecode: Hex = artifact.bytecode as Hex;
  const expectedRuntime: string = artifact.deployedBytecode;

  // --- resolve + encode constructor args ---
  const constructorAbi = (artifact.abi as Abi).find((e) => e.type === 'constructor') as ConstructorLike | undefined;
  const initCode = encodeInitCode(creationBytecode, constructorAbi, contract, input.resolvedAddresses ?? {}, input.externalAddresses ?? {}, await signer.getAddress());

  // --- chain id assertion ---
  const chainId = await transport.getChainId();
  assertChainIdMatches({ chainId: spec.chain.chainId, environment: spec.environment }, chainId);


  // --- serial, boring nonce + gas ---
  const deployer = await signer.getAddress();
  const nonce = await transport.getTransactionCount(deployer);
  const gas = (await transport.estimateGas({ from: deployer, data: initCode })) + 30000n;
  const gasPrice = input.fees ?? (await transport.estimateFeesPerGas());

  const raw = await signer.signTransaction({
    chainId,
    data: initCode,
    nonce,
    gas,
    ...gasPrice,
  });

  const txHash = await transport.sendRawTransaction(raw);
  await input.onTransition?.({ status: 'submitted', transactionHash: txHash });
  const receipt = await waitReceipt(transport, txHash, input.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS);
  if (receipt.status !== 'success') {
    throw new ConfigError('DEPLOY_REVERTED', `Deployment of '${logicalId}' did not succeed`, {
      details: { txHash, status: receipt.status },
    });
  }

  const address = receipt.contractAddress;
  if (!address) throw new ConfigError('DEPLOY_NO_ADDRESS', `No contract address for '${logicalId}'`);
  await input.onTransition?.({ status: 'confirmed', transactionHash: txHash, blockNumber: receipt.blockNumber, address });

  // --- post-deployment runtime-code verification ---
  await verifyRuntimeCode(transport, address, expectedRuntime, artifact.deployedLinkReferences, artifact.immutableReferences);
  await input.onTransition?.({ status: 'verified', transactionHash: txHash, blockNumber: receipt.blockNumber, address });

  const deployedParameters = paramsToRecord(contract.parameters);
  return {
    logicalId,
    artifactName: contract.artifactName,
    address,
    transactionHash: txHash,
    blockNumber: receipt.blockNumber,
    mode,
    deployedParameters,
  };
}

function encodeInitCode(
  creationBytecode: Hex,
  constructorAbi: ConstructorLike | undefined,
  contract: ResolvedContract,
  resolvedAddresses: Record<string, Address>,
  externalAddresses: Record<string, Address>,
  deployer: Address,
): Hex {
  if (!constructorAbi || constructorAbi.inputs.length === 0) {
    return creationBytecode;
  }
  const params = new Map(contract.parameters.map((p) => [p.name, p]));
  const scope: BindingScope = {
    parameters: new Map(contract.parameters.map((p) => [p.name, p.value])),
    addresses: resolvedAddresses,
    externalAddresses,
    deployer,
  };
  const args = constructorAbi.inputs.map((inp) => {
    const binding = inp.name !== undefined ? contract.constructorBindings?.[inp.name] : undefined;
    if (binding) return convertArg(resolveBindingValue(binding, scope), inp.type);
    const p = inp.name !== undefined ? params.get(inp.name) : undefined;
    if (!p) {
      throw new ConfigError(
        'UNRESOLVED_CONSTRUCTOR_ARG',
        `Constructor input '${inp.name ?? '<unnamed>'}' for '${contract.logicalId}' has no matching typed binding or resolved parameter`,
      );
    }
    return convertArg(p.value, inp.type);
  });
  return encodeDeployData({ abi: [constructorAbi] as unknown as Abi, bytecode: creationBytecode, args });
}

export function convertArg(value: ResolvedBindingValue, abiType: string): unknown {
  if (abiType.endsWith('[]')) {
    if (!Array.isArray(value)) throw new ConfigError('ABI_BINDING_TYPE_MISMATCH', `Expected array for ABI type '${abiType}'`);
    return value.map((item) => convertArg(item, abiType.slice(0, -2)));
  }
  if (abiType === 'bool') {
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  }
  if (abiType === 'address') return value as Address;
  if (abiType.startsWith('bytes')) return value as Hex;
  if (abiType.startsWith('string')) return String(value);
  if (abiType.startsWith('uint') || abiType.startsWith('int')) {
    return typeof value === 'bigint' ? value : BigInt(String(value));
  }
  return value;
}

function paramsToRecord(params: ResolvedParameter[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of params) out[p.name] = p.value;
  return out;
}

async function verifyRuntimeCode(
  transport: RpcTransport,
  address: Address,
  expectedRuntime: string,
  linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>> | undefined,
  immutableReferences: Record<string, Array<{ start: number; length: number }>> | undefined,
): Promise<void> {
  const code = await transport.getCode(address);
  if (!code || code === '0x') {
    throw new ConfigError('RUNTIME_CODE_MISSING', `No runtime code at ${address} after deployment`);
  }
  const variableRanges = [
    ...Object.values(linkReferences ?? {}).flatMap((byName) => Object.values(byName).flat()),
    ...Object.values(immutableReferences ?? {}).flat(),
  ];
  if (!runtimeMatches(expectedRuntime, code, variableRanges)) {
    throw new ConfigError(
      'RUNTIME_CODE_MISMATCH',
      `Runtime code at ${address} does not match the expected artifact bytecode`,
    );
  }
}

/** Compare all byte positions except artifact-declared link/immutable ranges. */
export function runtimeMatches(
  expected: string,
  observed: string,
  variableRanges: Array<{ start: number; length: number }>,
): boolean {
  const expectedBytes = normalizeBytecode(expected);
  const observedBytes = normalizeBytecode(observed);
  if (expectedBytes.length !== observedBytes.length) return false;
  const ignored = new Set<number>();
  for (const { start, length } of variableRanges) {
    for (let offset = start * 2; offset < (start + length) * 2; offset++) ignored.add(offset);
  }
  for (let i = 0; i < expectedBytes.length; i++) {
    if (!ignored.has(i) && expectedBytes[i] !== observedBytes[i]) return false;
  }
  return true;
}

async function waitReceipt(transport: RpcTransport, hash: Hex, timeoutMs: number): Promise<TransactionReceipt> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = await transport.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new ConfigError(
    'DEPLOY_RECEIPT_TIMEOUT',
    `No receipt for transaction ${hash} within ${timeoutMs}ms; the transaction may still be pending`,
    { details: { transactionHash: hash, timeoutMs } },
  );
}
