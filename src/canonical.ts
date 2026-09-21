/**
 * The canonical *resolved* deployment specification.
 *
 * This is the fully explicit object produced by the resolver after all EDN
 * config is parsed, artifacts are bound, relationships validated, governance
 * and verification resolved, and the environment overlay applied. It contains
 * no unresolved logical references required for deployment, and it is frozen
 * (hashed) before any transaction begins.
 *
 * It is intended to be serialized to canonical JSON for cross-language
 * consumption (e.g. by a future PRF deployment-conformance proof).
 */

import type { ResolvedArtifact } from './artifacts/types';

export type Scope = 'prf' | 'sew' | 'shared';
export type Mutability = 'immutable' | 'governed';

export type ResolvedConstraint =
  | { type: 'range'; min: string; max: string }
  | { type: 'oneOf'; values: string[] };

export interface ResolvedParameter {
  name: string;
  value: string | number | boolean;
  mutability: Mutability;
  constraint?: ResolvedConstraint;
  /** true when the initial value was overridden by the environment overlay. */
  overriddenByEnv: boolean;
  /** source of the value: 'architecture' | 'environment' */
  valueSource: 'architecture' | 'environment';
}

export interface ResolvedRelationship {
  key: string; // e.g. "dependsOn"
  target: string; // logical contract id
}

export interface ResolvedContract {
  logicalId: string;
  scope: Scope;
  artifactSource: string;
  artifactName: string;
  artifact: ResolvedArtifact;
  parameters: ResolvedParameter[];
  relationships: ResolvedRelationship[];
  deploymentOrder: number;
  /** governance groups that govern parameters on this contract (derived). */
  governedByGroups: string[];
}

export interface ResolvedGovernor {
  id: string;
  contract: string; // logical id
  token: string; // logical id of voting token
  tokenSource: string; // governance token id (e.g. "sew/token")
  quorum?: string;
  proposalThreshold?: string;
}

export interface ResolvedLane {
  id: string;
  governor: string; // governor id
  timelock: string; // logical contract id
}

export interface ResolvedOperation {
  id: string; // operation id within the group
  target: string; // logical contract id
  parameter: string; // parameter name
}

export interface ResolvedGovernanceGroup {
  id: string;
  lane: string; // lane id
  operations: ResolvedOperation[];
}

export interface ResolvedGovernance {
  governors: ResolvedGovernor[];
  lanes: ResolvedLane[];
  groups: ResolvedGovernanceGroup[];
}

export interface ResolvedVerificationProfile {
  id: string;
  verifierImplementation: string;
  programId?: string;
  vkHash?: string;
  statement?: string;
}

export interface ResolvedVerifierInstance {
  /** concrete logical contract id hosting the verifier implementation. */
  contract: string;
  artifactSource: string;
  artifactName: string;
}

export interface ResolvedVerification {
  applications: Array<{
    id: string;
    verificationProfile: string;
    profile: ResolvedVerificationProfile;
    verifierInstance: ResolvedVerifierInstance;
  }>;
  profiles: ResolvedVerificationProfile[];
  verifierInstances: Record<string, ResolvedVerifierInstance>;
}

export interface ResolvedChain {
  logicalRole: string;
  chainId: number;
  /** chain kind (local/testnet/mainnet) — NOT the runtime/provider. */
  kind?: 'local' | 'testnet' | 'mainnet';
  /** source of the chain binding. */
  source: string;
}

export interface DeploymentPlanStep {
  logicalId: string;
  order: number;
  /** declared dependencies that must already be satisfied by this point. */
  dependsOn: string[];
}

export interface ResolvedDeploymentPlan {
  steps: DeploymentPlanStep[];
  /** chain id declared in config; the execution layer must verify the
   *  connected RPC reports this same chain id. */
  chainId: number;
}

export interface ResolvedSpec {
  specVersion: number;
  environment: string;
  chain: ResolvedChain;
  artifacts: Record<string, ResolvedArtifact>; // keyed by "sourceId/artifactName"
  contracts: Record<string, ResolvedContract>; // keyed by logicalId
  governance: ResolvedGovernance;
  verification: ResolvedVerification;
  deployment: ResolvedDeploymentPlan;
  /**
   * Intended state: what this spec declares should be deployed/configured.
   * `observed` is deliberately absent here — it is recorded separately by the
   * deployment ledger after execution and is never part of the frozen spec.
   */
  intended: {
    chainId: number;
    contracts: Record<string, { logicalId: string; parameters: Record<string, unknown> }>;
  };
}
