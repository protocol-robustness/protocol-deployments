import { keccak256Hex } from '../artifacts/hash';
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { canonicalJson } from '../canonical-json';
import { ConfigError } from '../errors';
import { assertManifestVerified, computeManifestRoot, type DeploymentManifestV1 } from './manifest';
import type { RpcTransport } from '../runtime/transport';
import type { ResolvedSpec } from '../canonical';
import type { BundleConsumer } from '../artifacts/bundle';
import { runtimeMatches } from './engine';
import { assertChainIdMatches } from '../validate/checks';
import { resolveBindingValueAsync, type BindingScope } from './bindings';

export const LIVE_VERIFICATION_DOMAIN = 'protocol-deployment-verification:v1:';

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
): Promise<LiveVerificationV1> {
  assertManifestVerified(manifest);
  const manifestRoot = computeManifestRoot(manifest);
  const chainId = await transport.getChainId();
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

  const addresses: Record<string, Address> = Object.fromEntries(
    manifest.contracts.map((contract) => [contract.logicalId, contract.address]),
  );
  const scope: BindingScope = {
    addresses,
    externalAddresses: (spec.externalAddresses ?? {}) as Record<string, Address>,
    deployer: manifest.deployer,
    transport,
  };
  const assertions: LiveAssertionResult[] = [];
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

  const body = {
    type: 'protocol-deployment-verification/v1' as const,
    manifestRoot,
    chain: { id: chainId, blockNumber: block.number.toString(), blockHash: block.hash },
    contracts,
    assertions,
    result: 'passed' as const,
  };
  return {
    ...body,
    verificationRoot: `0x${keccak256Hex(`${LIVE_VERIFICATION_DOMAIN}${canonicalJson(body)}`)}`,
  };
}

/**
 * Every assertion the sealed manifest claims to have passed must be observed
 * again here; otherwise a manifest could be re-verified while silently
 * dropping the assertions it was originally gated on.
 */
function assertAllManifestAssertionsObserved(
  manifest: DeploymentManifestV1,
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
