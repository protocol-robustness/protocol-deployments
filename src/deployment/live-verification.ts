import { keccak256Hex } from '../artifacts/hash';
import { decodeFunctionResult, encodeFunctionData, hexToBytes, type Abi, type Address, type Hex } from 'viem';
import { canonicalJson } from '../canonical-json';
import { ConfigError } from '../errors';
import { assertManifestVerified, computeManifestRoot, type DeploymentManifest, type DeploymentManifestV1, type DeploymentManifestV2 } from './manifest';
import type { RpcTransport } from '../runtime/transport';
import type { ResolvedSpec } from '../canonical';
import type { BundleConsumer } from '../artifacts/bundle';
import { runtimeMatches } from './engine';
import { assertChainIdMatches } from '../validate/checks';
import { resolveBindingValueAsync, type BindingScope } from './bindings';
import { artifactIdentityOf, type ExternalContractObservationV1 } from './record';

export const LIVE_VERIFICATION_DOMAIN = 'protocol-deployment-verification:v1:';
export const LIVE_VERIFICATION_V2_DOMAIN = 'protocol-deployment-verification:v2:';

export interface LiveAssertionResult {
  id: string;
  target: string;
  function: string;
  expected: string;
  observed: string;
  result: 'passed';
}

export interface LiveVerificationV1 {
  type: 'protocol-deployment-verification/v1';
  manifestRoot: string;
  chain: { id: number; blockNumber: string; blockHash: Hex };
  contracts: Array<{
    logicalId: string;
    address: Address;
    artifactName: string;
    result: 'passed';
  }>;
  assertions: LiveAssertionResult[];
  result: 'passed';
  verificationRoot: string;
}

export interface LiveVerificationV2 extends Omit<LiveVerificationV1, 'type'> {
  type: 'protocol-deployment-verification/v2';
  externalContracts: Array<Pick<ExternalContractObservationV1, 'logicalId' | 'address' | 'observedRuntimeCodeKeccak256' | 'observedAt'> & { result: 'passed' }>;
}

function normalizeCode(code: Hex | undefined, logicalId: string): Hex {
  if (!code || code === '0x') {
    throw new ConfigError('RUNTIME_CODE_MISSING', `RPC returned no runtime bytecode for '${logicalId}'`);
  }
  return code.toLowerCase() as Hex;
}

function abiFunction(spec: ResolvedSpec, target: string, name: string): Abi[number] {
  const contract = spec.contracts[target];
  if (!contract) throw new ConfigError('UNKNOWN_LOGICAL_CONTRACT', `Unknown live assertion target '${target}'`);
  const entry = (contract.artifact.abi as Array<{ type?: string; name?: string }>).find((item) => item.type === 'function' && item.name === name);
  if (!entry) {
    throw new ConfigError('UNKNOWN_BOOTSTRAP_FUNCTION', `Function '${name}' is not in pinned ABI for '${target}'`);
  }
  return entry as Abi[number];
}

/**
 * Re-verify a sealed deployment manifest against a live chain.
 *
 * Fails closed: the manifest must be complete and internally verified, its
 * recorded deployment block hash must still be the chain's, every contract's
 * runtime code must match the pinned artifact, and every declared assertion
 * must be re-evaluated. Nothing here mutates the manifest.
 */
export async function verifyLiveDeployment(
  manifest: DeploymentManifestV1,
  transport: RpcTransport,
  spec: ResolvedSpec,
  bundle: BundleConsumer,
  requestedBlock?: bigint,
  externallyVerifiedAssertions?: LiveAssertionResult[],
): Promise<LiveVerificationV1>;
export async function verifyLiveDeployment(
  manifest: DeploymentManifestV2,
  transport: RpcTransport,
  spec: ResolvedSpec,
  bundle: BundleConsumer,
  requestedBlock?: bigint,
  externallyVerifiedAssertions?: LiveAssertionResult[],
): Promise<LiveVerificationV2>;
export async function verifyLiveDeployment(
  manifest: DeploymentManifest,
  transport: RpcTransport,
  spec: ResolvedSpec,
  bundle: BundleConsumer,
  requestedBlock?: bigint,
  externallyVerifiedAssertions: LiveAssertionResult[] = [],
): Promise<LiveVerificationV1 | LiveVerificationV2> {
  assertManifestVerified(manifest);
  const manifestRoot = computeManifestRoot(manifest);
  const chainId = await transport.getChainId();
  if (manifest.chain.id !== spec.chain.chainId) {
    throw new ConfigError('CHAIN_ID_MISMATCH', `Manifest chain ${manifest.chain.id} differs from resolved environment chain ${spec.chain.chainId}`);
  }
  assertChainIdMatches({ chainId: manifest.chain.id, environment: manifest.deploymentId }, chainId);

  // The recorded deployment block hash is part of the evidence; re-read it so
  // a chain that has been reset or reorged cannot silently satisfy the checks.
  const recordedBlock = await transport.getBlock(BigInt(manifest.chain.blockNumber));
  if (recordedBlock.hash.toLowerCase() !== manifest.chain.blockHash.toLowerCase()) {
    throw new ConfigError(
      'MANIFEST_BLOCK_MISMATCH',
      `Deployment block ${manifest.chain.blockNumber} hashes to ${recordedBlock.hash}, but the manifest recorded ${manifest.chain.blockHash}`,
    );
  }

  const block = await transport.getBlock(requestedBlock);
  if (requestedBlock === undefined && BigInt(manifest.chain.blockNumber) > block.number) {
    throw new ConfigError(
      'MANIFEST_BLOCK_AHEAD',
      `Manifest deployment block ${manifest.chain.blockNumber} is ahead of RPC block ${block.number}`,
    );
  }

  const contracts = [];
  for (const contract of manifest.contracts) {
    const code = normalizeCode(await transport.getCode(contract.address, block.number), contract.logicalId);
    const loaded = bundle.loadArtifact(
      contract.artifact.source,
      contract.artifact.package,
      contract.artifact.version,
      contract.artifact.artifactName,
    );
    const expectedRuntime = loaded.artifact.deployedBytecode;
    const variableRanges = [
      ...Object.values(loaded.artifact.deployedLinkReferences ?? {}).flatMap((byName) => Object.values(byName).flat()),
      ...Object.values(loaded.artifact.immutableReferences ?? {}).flat(),
    ];
    if (!runtimeMatches(expectedRuntime, code, variableRanges)) {
      throw new ConfigError(
        'RUNTIME_CODE_MISMATCH',
        `Runtime bytecode mismatch for '${contract.logicalId}': observed code does not match the pinned artifact`,
      );
    }
    contracts.push({
      logicalId: contract.logicalId,
      address: contract.address,
      artifactName: contract.artifact.artifactName,
      result: 'passed' as const,
    });
  }

  const externalContracts: LiveVerificationV2['externalContracts'] = [];
  if (manifest.type === 'protocol-deployment-manifest/v2') {
    const specExternal = spec.externalContracts ?? {};
    if (manifest.externalContracts.length !== Object.keys(specExternal).length) {
      throw new ConfigError('EXTERNAL_CONTRACT_SET_MISMATCH', 'Manifest external dependencies differ from the resolved specification');
    }
    for (const dependency of manifest.externalContracts) {
      const declared = specExternal[dependency.logicalId];
      const contract = spec.contracts[dependency.logicalId];
      if (!declared || !contract || contract.deploymentKind !== 'external' || declared.address.toLowerCase() !== dependency.address.toLowerCase()) {
        throw new ConfigError('EXTERNAL_CONTRACT_SPEC_MISMATCH', `Manifest external dependency '${dependency.logicalId}' differs from the resolved specification`);
      }
      if (canonicalJson(dependency.artifact) !== canonicalJson(artifactIdentityOf(contract))) {
        throw new ConfigError('EXTERNAL_CONTRACT_SPEC_MISMATCH', `Manifest artifact identity for external dependency '${dependency.logicalId}' differs from the pinned specification`);
      }
      const loaded = bundle.loadArtifact(contract.artifactSource, contract.artifact.package, contract.artifact.version, contract.artifactName);
      const variableRanges = [
        ...Object.values(loaded.artifact.deployedLinkReferences ?? {}).flatMap((byName) => Object.values(byName).flat()),
        ...Object.values(loaded.artifact.immutableReferences ?? {}).flat(),
      ];
      const observationBlock = await transport.getBlock(BigInt(dependency.observedAt.blockNumber));
      if (observationBlock.hash.toLowerCase() !== dependency.observedAt.blockHash.toLowerCase()) {
        throw new ConfigError('EXTERNAL_CONTRACT_OBSERVATION_BLOCK_MISMATCH', `Recorded observation block for '${dependency.logicalId}' has changed`);
      }
      const observedCode = normalizeCode(await transport.getCode(dependency.address, observationBlock.number), dependency.logicalId);
      const observedHash = `0x${keccak256Hex(hexToBytes(observedCode as Hex))}`;
      if (observedHash.toLowerCase() !== dependency.observedRuntimeCodeKeccak256.toLowerCase() || !runtimeMatches(loaded.artifact.deployedBytecode, observedCode, variableRanges)) {
        throw new ConfigError('EXTERNAL_CONTRACT_OBSERVATION_MISMATCH', `Recorded external contract code observation for '${dependency.logicalId}' does not match the chain`);
      }
      const liveCode = normalizeCode(await transport.getCode(dependency.address, block.number), dependency.logicalId);
      if (`0x${keccak256Hex(hexToBytes(liveCode as Hex))}`.toLowerCase() !== dependency.observedRuntimeCodeKeccak256.toLowerCase() || !runtimeMatches(loaded.artifact.deployedBytecode, liveCode, variableRanges)) {
        throw new ConfigError('EXTERNAL_CONTRACT_CODE_MISMATCH', `Current runtime bytecode for external contract '${dependency.logicalId}' differs from the verified observation`);
      }
      externalContracts.push({ logicalId: dependency.logicalId, address: dependency.address, observedRuntimeCodeKeccak256: observedHash, observedAt: dependency.observedAt, result: 'passed' });
    }
  } else if (Object.keys(spec.externalContracts ?? {}).length > 0) {
    throw new ConfigError('EXTERNAL_CONTRACT_MANIFEST_REQUIRED', 'Resolved specification has external dependencies but manifest is V1');
  }

  const addresses: Record<string, Address> = Object.fromEntries(
    manifest.contracts.map((contract) => [contract.logicalId, contract.address]),
  );
  for (const dependency of externalContracts) addresses[dependency.logicalId] = dependency.address;
  const scope: BindingScope = {
    addresses,
    externalAddresses: (spec.externalAddresses ?? {}) as Record<string, Address>,
    deployer: manifest.deployer,
    transport,
  };
  const assertions: LiveAssertionResult[] = [...externallyVerifiedAssertions];
  for (const assertion of spec.deployment.bootstrapAssertions ?? []) {
    const target = addresses[assertion.target];
    if (!target) {
      throw new ConfigError('UNRESOLVED_CONTRACT_ADDRESS', `Live assertion target '${assertion.target}' is not present in the manifest`);
    }
    const entry = abiFunction(spec, assertion.target, assertion.function);
    const abi = [entry] as unknown as Abi;
    const args = await Promise.all(assertion.args.map((arg) => resolveBindingValueAsync(arg, scope)));
    const data = encodeFunctionData({ abi, functionName: assertion.function, args });
    const observedValue = decodeFunctionResult({
      abi,
      functionName: assertion.function,
      data: await transport.call({ to: target, data }, block.number),
    });
    const expectedValue = typeof assertion.expected === 'object'
      ? await resolveBindingValueAsync(assertion.expected, scope)
      : assertion.expected;
    if (String(observedValue).toLowerCase() !== String(expectedValue).toLowerCase()) {
      throw new ConfigError(
        'BOOTSTRAP_ASSERTION_FAILED',
        `Live assertion '${assertion.id}' failed: expected ${String(expectedValue)}, observed ${String(observedValue)}`,
      );
    }
    assertions.push({ id: assertion.id, target: assertion.target, function: assertion.function, expected: String(expectedValue), observed: String(observedValue), result: 'passed' });
  }
  assertAllManifestAssertionsObserved(manifest, assertions);

  const body = manifest.type === 'protocol-deployment-manifest/v2' ? {
    type: 'protocol-deployment-verification/v2' as const,
    manifestRoot,
    chain: { id: chainId, blockNumber: block.number.toString(), blockHash: block.hash },
    contracts,
    externalContracts,
    assertions,
    result: 'passed' as const,
  } : {
    type: 'protocol-deployment-verification/v1' as const,
    manifestRoot,
    chain: { id: chainId, blockNumber: block.number.toString(), blockHash: block.hash },
    contracts,
    assertions,
    result: 'passed' as const,
  };
  return {
    ...body,
    verificationRoot: `0x${keccak256Hex(`${body.type === 'protocol-deployment-verification/v2' ? LIVE_VERIFICATION_V2_DOMAIN : LIVE_VERIFICATION_DOMAIN}${canonicalJson(body)}`)}`,
  };
}

/**
 * Every assertion the sealed manifest claims to have passed must be observed
 * again here; otherwise a manifest could be re-verified while silently
 * dropping the assertions it was originally gated on.
 */
function assertAllManifestAssertionsObserved(
  manifest: DeploymentManifest,
  observed: LiveAssertionResult[],
): void {
  const observedIds = new Set(observed.map((assertion) => assertion.id));
  const unverifiable = manifest.finalAssertions
    .filter((assertion) => assertion.status === 'passed' && !observedIds.has(assertion.id))
    .map((assertion) => assertion.id);
  if (unverifiable.length > 0) {
    throw new ConfigError(
      'LIVE_ASSERTION_GAP',
      `Manifest records final assertions that this verification did not evaluate: ${unverifiable.join(', ')}`,
    );
  }
}
