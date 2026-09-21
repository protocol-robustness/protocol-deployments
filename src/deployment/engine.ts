import {
  encodeDeployData,
  getContractAddress,
  type Address,
  type Hex,
  type Abi,
} from 'viem';
import { ConfigError } from '../errors';
import type { BundleConsumer } from '../artifacts/bundle';
import type { RpcTransport } from '../runtime/transport';
import type { Signer } from '../runtime/signer';
import type { ResolvedSpec, ResolvedContract, ResolvedParameter } from '../canonical';
import { assertChainIdMatches } from '../validate/checks';
import { normalizeBytecode } from '../artifacts/hash';

export type DeploymentMode = 'create' | 'create2';

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
  salt?: Hex;
  create2Factory?: Address;
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
  const initCode = encodeInitCode(creationBytecode, constructorAbi, contract);

  // --- chain id assertion ---
  const chainId = await transport.getChainId();
  assertChainIdMatches({ chainId: spec.chain.chainId, environment: spec.environment }, chainId);

  // --- derive/validate expected address (CREATE2) ---
  let expectedAddress: Address | undefined;
  if (mode === 'create2') {
    if (!input.salt || !input.create2Factory) {
      throw new ConfigError('CREATE2_REQUIRES_FACTORY', `Contract '${logicalId}' in create2 mode requires :salt and :create2Factory`);
    }
    expectedAddress = getContractAddress({
      from: input.create2Factory,
      salt: input.salt,
      bytecode: initCode,
      opcode: 'CREATE2',
    });
  }

  // --- serial, boring nonce + gas ---
  const deployer = await signer.getAddress();
  const nonce = await transport.getTransactionCount(deployer);
  const gas = (await transport.estimateGas({ from: deployer, data: initCode })) + 30000n;
  const gasPrice = { maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n };

  const raw = await signer.signTransaction({
    chainId,
    data: initCode,
    nonce,
    gas,
    ...gasPrice,
  });

  const txHash = await transport.sendRawTransaction(raw);
  const receipt = await waitReceipt(transport, txHash);
  if (!receipt || receipt.status !== 'success') {
    throw new ConfigError('DEPLOY_REVERTED', `Deployment of '${logicalId}' did not succeed`, {
      details: { txHash, status: receipt?.status ?? 'missing' },
    });
  }

  const address = receipt.contractAddress ?? expectedAddress;
  if (!address) throw new ConfigError('DEPLOY_NO_ADDRESS', `No contract address for '${logicalId}'`);

  if (mode === 'create2' && expectedAddress && address !== expectedAddress) {
    throw new ConfigError('CREATE2_ADDRESS_MISMATCH', `CREATE2 address ${address} != expected ${expectedAddress}`);
  }

  // --- post-deployment runtime-code verification ---
  await verifyRuntimeCode(transport, address, expectedRuntime, artifact.linkReferences);

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
): Hex {
  if (!constructorAbi || constructorAbi.inputs.length === 0) {
    return creationBytecode;
  }
  const params = new Map(contract.parameters.map((p) => [p.name, p]));
  const args = constructorAbi.inputs.map((inp) => {
    const p = inp.name !== undefined ? params.get(inp.name) : undefined;
    if (p === undefined) {
      throw new ConfigError(
        'UNRESOLVED_CONSTRUCTOR_ARG',
        `Constructor input '${inp.name ?? '<unnamed>'}' for '${contract.logicalId}' has no matching resolved parameter`,
      );
    }
    return convertArg(p.value, inp.type);
  });
  return encodeDeployData({ abi: [constructorAbi] as unknown as Abi, bytecode: creationBytecode, args });
}

/** Convert a resolved parameter value (string/number/boolean) to an ABI arg. */
export function convertArg(value: string | number | boolean, abiType: string): unknown {
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
  linkReferences: Record<string, unknown> | undefined,
): Promise<void> {
  const code = await transport.getCode(address);
  if (!code || code === '0x') {
    throw new ConfigError('RUNTIME_CODE_MISSING', `No runtime code at ${address} after deployment`);
  }
  // Contracts with library link references or immutables cannot be compared
  // byte-for-byte (placeholders are resolved on-chain); skip exact match then.
  const hasLinks = Object.keys(linkReferences ?? {}).length > 0;
  if (hasLinks) return;
  if (normalizeBytecode(code) !== normalizeBytecode(expectedRuntime)) {
    throw new ConfigError(
      'RUNTIME_CODE_MISMATCH',
      `Runtime code at ${address} does not match the expected artifact bytecode`,
    );
  }
}

async function waitReceipt(transport: RpcTransport, hash: Hex) {
  for (let i = 0; i < 60; i++) {
    const r = await transport.getTransactionReceipt(hash);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}
