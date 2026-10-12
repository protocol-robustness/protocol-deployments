import { decodeFunctionResult, encodeFunctionData, hexToBytes, type Abi, type Address, type Hex } from 'viem';
import { keccak256Hex } from '../artifacts/hash';
import type { BundleConsumer } from '../artifacts/bundle';
import { ConfigError } from '../errors';
import type { ResolvedSpec } from '../canonical';
import type { RpcTransport } from '../runtime/transport';
import { assertChainIdMatches } from '../validate/checks';
import { canonicalJson } from '../canonical-json';
import { resolveBindingValueAsync, type BindingScope } from './bindings';
import { runtimeMatches } from './engine';
import { artifactIdentityOf, type ExternalContractObservationV1 } from './record';

/** Verify external contract dependencies before any deployment transaction is sent. */
export async function verifyExternalContracts(
  spec: ResolvedSpec,
  bundle: BundleConsumer,
  transport: RpcTransport,
  deployer?: Address,
): Promise<ExternalContractObservationV1[]> {
  const dependencies = Object.entries(spec.externalContracts ?? {});
  if (dependencies.length === 0) return [];

  const chainId = await transport.getChainId();
  assertChainIdMatches({ chainId: spec.chain.chainId, environment: spec.environment }, chainId);
  const block = await transport.getBlock();
  const observations: ExternalContractObservationV1[] = [];
  const addresses = Object.fromEntries(dependencies.map(([logicalId, dependency]) => [logicalId, dependency.address as Address]));

  for (const [logicalId, dependency] of dependencies) {
    const contract = spec.contracts[logicalId];
    if (!contract || contract.deploymentKind !== 'external' || contract.externalAddress?.toLowerCase() !== dependency.address.toLowerCase()) {
      throw new ConfigError('EXTERNAL_CONTRACT_SPEC_MISMATCH', `External dependency '${logicalId}' is not consistently declared in the resolved spec`);
    }
    const loaded = bundle.loadArtifact(contract.artifactSource, contract.artifact.package, contract.artifact.version, contract.artifactName);
    const code = await transport.getCode(dependency.address as Address, block.number);
    if (!code || code === '0x') throw new ConfigError('EXTERNAL_CONTRACT_CODE_MISSING', `No runtime code at external contract '${logicalId}' (${dependency.address})`);
    const variableRanges = [
      ...Object.values(loaded.artifact.deployedLinkReferences ?? {}).flatMap((byName) => Object.values(byName).flat()),
      ...Object.values(loaded.artifact.immutableReferences ?? {}).flat(),
    ];
    if (!runtimeMatches(loaded.artifact.deployedBytecode, code, variableRanges)) {
      throw new ConfigError('EXTERNAL_CONTRACT_CODE_MISMATCH', `Runtime bytecode at external contract '${logicalId}' does not match the pinned artifact`);
    }
    observations.push({
      logicalId,
      address: dependency.address as Address,
      artifact: artifactIdentityOf(contract),
      observedRuntimeCodeKeccak256: `0x${keccak256Hex(hexToBytes(code as Hex))}`,
      observedAt: { blockNumber: block.number.toString(), blockHash: block.hash },
    });
  }

  // Assertions on external dependencies are preflight gates: do not deploy
  // other contracts first and only discover later that the selected external
  // token/verifier lacks the required interface or identity.
  const externalIds = new Set(dependencies.map(([logicalId]) => logicalId));
  const scope: BindingScope = {
    addresses,
    externalAddresses: (spec.externalAddresses ?? {}) as Record<string, Address>,
    deployer,
    transport,
  };
  for (const assertion of spec.deployment.bootstrapAssertions ?? []) {
    if (!externalIds.has(assertion.target)) continue;
    const contract = spec.contracts[assertion.target]!;
    const entry = (contract.artifact.abi as Array<{ type?: string; name?: string }>).find(
      (item) => item.type === 'function' && item.name === assertion.function,
    );
    if (!entry) throw new ConfigError('UNKNOWN_BOOTSTRAP_FUNCTION', `Function '${assertion.function}' is not in ${contract.logicalId}'s pinned ABI`);
    const abi = [entry] as unknown as Abi;
    const args = await Promise.all(assertion.args.map((arg) => resolveBindingValueAsync(arg, scope)));
    const data = encodeFunctionData({ abi, functionName: assertion.function, args });
    const observed = decodeFunctionResult({
      abi,
      functionName: assertion.function,
      data: await transport.call({ to: addresses[assertion.target]!, data }, block.number),
    });
    const expected = typeof assertion.expected === 'object'
      ? await resolveBindingValueAsync(assertion.expected, scope)
      : assertion.expected;
    if (String(observed).toLowerCase() !== String(expected).toLowerCase()) {
      throw new ConfigError(
        'EXTERNAL_CONTRACT_ASSERTION_FAILED',
        `External dependency assertion '${assertion.id}' failed before deployment: expected ${String(expected)}, observed ${String(observed)}`,
      );
    }
  }

  return observations;
}
