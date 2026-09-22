import type { Address } from 'viem';
import { canonicalJson } from '../canonical-json';
import { keccak256Hex } from '../artifacts/hash';
import type { ResolvedBinding, ResolvedSpec } from '../canonical';
import { ConfigError } from '../errors';

export const EXECUTION_SPEC_HASH_DOMAIN = 'prf-deployment-execution-spec:v1:';

export interface ExecutionSpecV1 {
  type: 'protocol-deployment-execution-spec/v1';
  architectureSpecHash: string;
  chainId: number;
  deployer: Address;
  externalAddresses: Record<string, Address>;
  contracts: Record<string, { constructorBindings?: Record<string, MaterializedBinding> }>;
}

export type MaterializedBinding = string | number | boolean | MaterializedBinding[];

export function materializeExecutionSpec(
  spec: ResolvedSpec,
  architectureSpecHash: string,
  deployer: Address,
  externalAddresses: Record<string, Address> = {},
): { executionSpec: ExecutionSpecV1; executionSpecHash: string } {
  const addresses: Record<string, Address> = {};
  const contracts: ExecutionSpecV1['contracts'] = {};
  for (const step of spec.deployment.steps) {
    const contract = spec.contracts[step.logicalId]!;
    contracts[step.logicalId] = {
      constructorBindings: contract.constructorBindings
        ? Object.fromEntries(Object.entries(contract.constructorBindings).map(([name, binding]) => [
            name,
            materializeBinding(binding, contract.parameters, addresses, deployer, externalAddresses),
          ]))
        : undefined,
    };
    // Deployment addresses are intentionally not materialized here for CREATE:
    // they are observed facts. A later contract-address binding remains symbolic.
    addresses[step.logicalId] = undefined as unknown as Address;
  }
  const executionSpec: ExecutionSpecV1 = {
    type: 'protocol-deployment-execution-spec/v1',
    architectureSpecHash,
    chainId: spec.chain.chainId,
    deployer,
    externalAddresses,
    contracts,
  };
  return { executionSpec, executionSpecHash: computeExecutionSpecHash(executionSpec) };
}

export function computeExecutionSpecHash(executionSpec: ExecutionSpecV1): string {
  return `0x${keccak256Hex(`${EXECUTION_SPEC_HASH_DOMAIN}${canonicalJson(executionSpec)}`)}`;
}

function materializeBinding(
  binding: ResolvedBinding,
  parameters: Array<{ name: string; value: string | number | boolean }>,
  contractAddresses: Record<string, Address>,
  deployer: Address,
  externalAddresses: Record<string, Address>,
): MaterializedBinding {
  switch (binding.kind) {
    case 'literal': return binding.value;
    case 'parameter': {
      const p = parameters.find((candidate) => candidate.name === binding.parameter);
      if (!p) throw new ConfigError('UNKNOWN_BINDING_PARAMETER', `No resolved parameter '${binding.parameter}'`);
      return p.value;
    }
    case 'deployer': return deployer;
    case 'external-address': {
      const address = externalAddresses[binding.name];
      if (!address) throw new ConfigError('UNKNOWN_EXTERNAL_ADDRESS', `No materialized external address '${binding.name}'`);
      return address;
    }
    case 'contract-address':
      // A CREATE address is only known after its earlier step confirms. The executor
      // resolves this symbolic reference from its durable record at execution time.
      if (!contractAddresses[binding.contract]) return `@contract:${binding.contract}`;
      return contractAddresses[binding.contract]!;
    case 'runtime-code-hash':
      // Runtime code is observed after deployment, so preserve the typed symbolic
      // dependency in the immutable execution specification.
      return `@runtime-code-hash:${binding.contract}`;
    case 'array': return binding.values.map((value) => materializeBinding(value, parameters, contractAddresses, deployer, externalAddresses));
  }
}
