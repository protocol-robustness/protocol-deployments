import { createHash } from 'crypto';
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { canonicalJson } from '../canonical-json';
import { computeManifestRoot, type DeploymentManifestV1 } from './manifest';
import type { RpcTransport } from '../runtime/transport';
import type { ResolvedBootstrapAssertion, ResolvedBinding, ResolvedSpec } from '../canonical';
import type { BundleConsumer } from '../artifacts/bundle';
import { runtimeMatches } from './engine';

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

function normalizeCode(code: Hex | undefined): Hex {
  if (!code || code === '0x') throw new Error('RPC returned no runtime bytecode');
  return code.toLowerCase() as Hex;
}

function resolveBinding(binding: ResolvedBinding, addresses: Record<string, Address>): unknown {
  if (binding.kind === 'literal') return binding.value;
  if (binding.kind === 'contract-address') {
    const address = addresses[binding.contract];
    if (!address) throw new Error(`Unknown assertion contract '${binding.contract}'`);
    return address;
  }
  throw new Error(`Live assertion binding '${binding.kind}' is not supported in this verification slice`);
}

function abiFunction(spec: ResolvedSpec, target: string, name: string): Abi[number] {
  const contract = spec.contracts[target];
  if (!contract) throw new Error(`Unknown live assertion target '${target}'`);
  const entry = (contract.artifact.abi as Array<{ type?: string; name?: string }>).find((item) => item.type === 'function' && item.name === name);
  if (!entry) throw new Error(`Function '${name}' is not in pinned ABI for '${target}'`);
  return entry as Abi[number];
}

export async function verifyLiveDeployment(
  manifest: DeploymentManifestV1,
  transport: RpcTransport,
  requestedBlock?: bigint,
  spec?: ResolvedSpec,
  bundle?: BundleConsumer,
): Promise<LiveVerificationV1> {
  const manifestRoot = computeManifestRoot(manifest);
  const chainId = await transport.getChainId();
  if (chainId !== manifest.chain.id) {
    throw new Error(`Chain ID mismatch: manifest=${manifest.chain.id}, RPC=${chainId}`);
  }

  const block = await transport.getBlock(requestedBlock);
  if (requestedBlock === undefined && BigInt(manifest.chain.blockNumber) > block.number) {
    throw new Error(`Manifest deployment block ${manifest.chain.blockNumber} is ahead of RPC block ${block.number}`);
  }

  const contracts = [];
  for (const contract of manifest.contracts) {
    const code = normalizeCode(await transport.getCode(contract.address, block.number));
    if (!bundle) {
      // Without the pinned artifact we cannot normalize constructor immutables,
      // so this verification slice must fail closed rather than guess.
      throw new Error(
        `Cannot verify runtime bytecode for '${contract.logicalId}' without a pinned artifact bundle; ` +
          'pass --fixtures so immutable/link ranges can be normalized',
      );
    }
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
      throw new Error(`Runtime bytecode mismatch for '${contract.logicalId}': observed code does not match the pinned artifact`);
    }
    contracts.push({
      logicalId: contract.logicalId,
      address: contract.address,
      artifactName: contract.artifact.artifactName,
      result: 'passed' as const,
    });
  }

  const assertions: LiveAssertionResult[] = [];
  if (spec) {
    const addresses = Object.fromEntries(manifest.contracts.map((contract) => [contract.logicalId, contract.address]));
    for (const assertion of spec.deployment.bootstrapAssertions ?? []) {
      const entry = abiFunction(spec, assertion.target, assertion.function);
      const abi = [entry] as unknown as Abi;
      const args = assertion.args.map((arg) => resolveBinding(arg, addresses));
      const data = encodeFunctionData({ abi, functionName: assertion.function, args });
      const observedValue = decodeFunctionResult({
        abi,
        functionName: assertion.function,
        data: await transport.call({ to: addresses[assertion.target], data }, block.number),
      });
      const expectedValue = typeof assertion.expected === 'object'
        ? resolveBinding(assertion.expected, addresses)
        : assertion.expected;
      if (String(observedValue).toLowerCase() !== String(expectedValue).toLowerCase()) {
        throw new Error(`Live assertion '${assertion.id}' failed: expected ${String(expectedValue)}, observed ${String(observedValue)}`);
      }
      assertions.push({ id: assertion.id, target: assertion.target, function: assertion.function, expected: String(expectedValue), observed: String(observedValue), result: 'passed' });
    }
  }

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
    verificationRoot: `0x${createHash('sha256').update(`protocol-deployment-verification:v1:${canonicalJson(body)}`).digest('hex')}`,
  };
}
