import type { Address } from 'viem';
import { keccak256 } from 'viem';
import { ConfigError } from '../errors';
import type { ResolvedBinding } from '../canonical';
import type { RpcTransport } from '../runtime/transport';

/**
 * Shared scope for turning a `ResolvedBinding` into a concrete value.
 *
 * The codebase resolves bindings at three distinct stages, and conflating
 * them is what previously produced five drifting copies:
 *
 *  - `src/resolver.ts` turns raw EDN into a typed `ResolvedBinding` (no values yet);
 *  - this module resolves a typed binding against observed runtime facts;
 *  - `execution-spec.ts` *materializes* a binding into a hashed, partly
 *    symbolic execution specification and is deliberately not a value resolver.
 *
 * Callers that own policy (which kinds are legal for a constructor, a
 * bootstrap action, or a live assertion) filter those kinds before delegating
 * the common cases here, so the shared facts — missing address, missing
 * parameter, missing deployer — cannot drift apart.
 *
 * Two rules are encoded once here instead of per caller:
 *
 *  - a scope without `parameters` rejects `parameter` bindings, so bootstrap
 *    actions and their read-only assertions always operate on materialized
 *    values and a later governed parameter change cannot rewrite them;
 *  - `runtime-code-hash` is only resolvable through the async entry point,
 *    because it must be read from the chain.
 */
export interface BindingScope {
  /** Resolved parameter values for the owning contract, keyed by parameter name. */
  parameters?: ReadonlyMap<string, string | number | boolean>;
  /** Addresses confirmed by earlier deployment steps, keyed by logical ID. */
  addresses?: Readonly<Record<string, Address>>;
  /** Materialized environment address bindings. */
  externalAddresses?: Readonly<Record<string, Address>>;
  /** The address that signs the transaction being built. */
  deployer?: Address;
  /** Chain access, required only by `runtime-code-hash` bindings. */
  transport?: RpcTransport;
}

/** A fully materialized binding: an ABI value or a nested list of them. */
export type ResolvedBindingValue = string | number | boolean | ResolvedBindingValue[];

/** Resolve every binding kind that does not need async chain reads or policy. */
export function resolveBindingValue(binding: ResolvedBinding, scope: BindingScope = {}): ResolvedBindingValue {
  switch (binding.kind) {
    case 'literal':
      return binding.value;
    case 'deployer': {
      if (!scope.deployer) {
        throw new ConfigError('UNRESOLVED_DEPLOYER', 'Deployer address is not available in this binding scope');
      }
      return scope.deployer;
    }
    case 'contract-address': {
      const address = scope.addresses?.[binding.contract];
      if (!address) {
        throw new ConfigError('UNRESOLVED_CONTRACT_ADDRESS', `Contract address '${binding.contract}' is not available`);
      }
      return address;
    }
    case 'external-address': {
      const address = scope.externalAddresses?.[binding.name];
      if (!address) {
        throw new ConfigError('UNKNOWN_EXTERNAL_ADDRESS', `External address '${binding.name}' is not available`);
      }
      return address;
    }
    case 'parameter': {
      if (!scope.parameters) {
        throw new ConfigError(
          'BOOTSTRAP_PARAMETER_UNSUPPORTED',
          `Parameter binding '${binding.parameter}' must be materialized explicitly: this binding scope carries no resolved parameters`,
        );
      }
      const value = scope.parameters.get(binding.parameter);
      if (value === undefined) {
        throw new ConfigError('UNKNOWN_BINDING_PARAMETER', `Unknown bound parameter '${binding.parameter}'`);
      }
      return value;
    }
    case 'array':
      return binding.values.map((item) => resolveBindingValue(item, scope));
    case 'runtime-code-hash':
      throw new ConfigError(
        'RUNTIME_CODE_HASH_CONSTRUCTOR_UNSUPPORTED',
        `Runtime code hash binding '${binding.contract}' is only valid for bootstrap actions`,
      );
  }
}

/**
 * Async variant: additionally resolves `runtime-code-hash` bindings by reading
 * the target's deployed code. Every other kind is delegated to the shared
 * synchronous resolver so the two paths cannot disagree.
 */
export async function resolveBindingValueAsync(binding: ResolvedBinding, scope: BindingScope): Promise<ResolvedBindingValue> {
  if (binding.kind === 'array') {
    const values = await Promise.all(binding.values.map((item) => resolveBindingValueAsync(item, scope)));
    return values;
  }
  if (binding.kind !== 'runtime-code-hash') return resolveBindingValue(binding, scope);

  const address = scope.addresses?.[binding.contract];
  if (!address) {
    throw new ConfigError('UNRESOLVED_CONTRACT_ADDRESS', `Runtime code hash binding '${binding.contract}' is not available`);
  }
  if (!scope.transport) {
    throw new ConfigError('RUNTIME_CODE_UNAVAILABLE', `Runtime code hash binding '${binding.contract}' requires chain access`);
  }
  const code = await scope.transport.getCode(address);
  if (!code || code === '0x') {
    throw new ConfigError('RUNTIME_CODE_UNAVAILABLE', `No runtime code found for '${binding.contract}'`);
  }
  return keccak256(code);
}
