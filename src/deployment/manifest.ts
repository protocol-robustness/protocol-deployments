import type { Address, Hex } from 'viem';
import { canonicalJson } from '../canonical-json';
import { keccak256Hex } from '../artifacts/hash';
import { ConfigError } from '../errors';
import type { DeploymentRecord } from './record';

export const DEPLOYMENT_MANIFEST_DOMAIN = 'protocol-deployment-manifest:v1:';
export const DEPLOYMENT_MANIFEST_V2_DOMAIN = 'protocol-deployment-manifest:v2:';
export const REGISTRY_CANDIDATE_DOMAIN = 'registry-binding-candidate:v1:';

/** Immutable evidence emitted only after every bootstrap step and assertion verifies. */
export interface DeploymentManifestV1 {
  type: 'protocol-deployment-manifest/v1';
  architectureSpecHash: string;
  executionSpecHash: string;
  deploymentId: string;
  chain: { id: number; blockNumber: string; blockHash: Hex };
  deployer: Address;
  contracts: Array<{
    logicalId: string;
    address: Address;
    artifact: DeploymentRecord['contracts'][string]['artifact'];
    runtimeCodeHash?: string;
    deploymentTx: Hex;
    blockNumber: string;
  }>;
  bootstrapActions: DeploymentRecord['bootstrapActions'];
  finalAssertions: DeploymentRecord['finalAssertions'];
}

/** V2 binds independently verified external dependencies separately from deployment facts. */
export interface DeploymentManifestV2 extends Omit<DeploymentManifestV1, 'type'> {
  type: 'protocol-deployment-manifest/v2';
  externalContracts: NonNullable<DeploymentRecord['externalContracts']>;
}

export type DeploymentManifest = DeploymentManifestV1 | DeploymentManifestV2;

export function computeManifestRoot(manifest: DeploymentManifest): string {
  const domain = manifest.type === 'protocol-deployment-manifest/v2' ? DEPLOYMENT_MANIFEST_V2_DOMAIN : DEPLOYMENT_MANIFEST_DOMAIN;
  return `0x${keccak256Hex(`${domain}${canonicalJson(manifest)}`)}`;
}

/** A deliberately tiny hand-off: registry tooling decides admission and selection. */
export interface RegistryBindingCandidateV1 {
  type: 'registry-binding-candidate/v1';
  candidateRoot: string;
  deploymentManifestRoot: string;
  chainId: number;
  localOnly: boolean;
  projection: { type: 'deployment-manifest-roots/v1'; registryRoots: string[] };
  roots: Array<{ logicalId: string; address: Address; artifactName: string }>;
}

export function registryBindingCandidate(manifest: DeploymentManifest, registryRoots: string[] = [], localOnly = false): RegistryBindingCandidateV1 {
  validateManifestForRegistryCandidate(manifest);
  const selected = registryRoots.length === 0
    ? manifest.contracts
    : registryRoots.map((logicalId) => {
      const contract = manifest.contracts.find((candidate) => candidate.logicalId === logicalId);
      if (!contract) {
        throw new ConfigError('MANIFEST_ROOT_MISSING', `Registry root '${logicalId}' is not present in the deployment manifest`);
      }
      return contract;
    });
  const body = {
    type: 'registry-binding-candidate/v1' as const,
    deploymentManifestRoot: computeManifestRoot(manifest),
    chainId: manifest.chain.id,
    localOnly,
    projection: {
      type: 'deployment-manifest-roots/v1' as const,
      registryRoots: registryRoots.length === 0 ? manifest.contracts.map((contract) => contract.logicalId) : registryRoots,
    },
    roots: selected.map((contract) => ({
      logicalId: contract.logicalId,
      address: contract.address,
      artifactName: contract.artifact.artifactName,
    })),
  };
  return {
    ...body,
    candidateRoot: `0x${keccak256Hex(`${REGISTRY_CANDIDATE_DOMAIN}${canonicalJson(body)}`)}`,
  };
}

/**
 * A manifest may only be re-checked or handed off once every fact it reports
 * has actually verified on chain. Both live re-verification and registry
 * handoff depend on this gate, so it fails closed on incomplete evidence,
 * unverified bootstrap actions, and failed final assertions alike.
 */
export function assertManifestVerified(manifest: DeploymentManifest): void {
  if (manifest.contracts.length === 0) {
    throw new ConfigError('MANIFEST_INCOMPLETE', 'Deployment manifest contains no contracts');
  }
  const deployedContractIds = manifest.contracts.map((contract) => contract.logicalId);
  if (new Set(deployedContractIds).size !== deployedContractIds.length) {
    throw new ConfigError('MANIFEST_DUPLICATE_CONTRACT_ID', 'Manifest contains duplicate deployed contract identities');
  }
  if (!manifest.chain.blockHash) {
    throw new ConfigError('MANIFEST_INCOMPLETE', 'Deployment manifest does not record the deployment block hash');
  }
  const assertionIds = manifest.finalAssertions.map((assertion) => assertion.id);
  if (new Set(assertionIds).size !== assertionIds.length) {
    throw new ConfigError('MANIFEST_DUPLICATE_FINAL_ASSERTIONS', 'Deployment manifest contains duplicate final assertion identities');
  }
  const unverified = manifest.bootstrapActions.filter((action) => action.status !== 'verified');
  if (unverified.length > 0) {
    throw new ConfigError(
      'MANIFEST_UNVERIFIED_BOOTSTRAP',
      `Deployment manifest has unverified bootstrap actions: ${unverified.map((action) => action.id).join(', ')}`,
    );
  }
  const failed = manifest.finalAssertions.filter((assertion) => assertion.status !== 'passed');
  if (failed.length > 0) {
    throw new ConfigError(
      'MANIFEST_FAILED_ASSERTIONS',
      `Deployment manifest has failed final assertions: ${failed.map((assertion) => assertion.id).join(', ')}`,
    );
  }
  for (const contract of manifest.contracts) {
    if (!contract.logicalId || !contract.address || !contract.deploymentTx || !contract.blockNumber) {
      throw new ConfigError('MANIFEST_INCOMPLETE', 'Deployment manifest has an incomplete deployment fact');
    }
    if (!contract.artifact.artifactName || !contract.artifact.runtimeBytecodeSha256) {
      throw new ConfigError('MANIFEST_INCOMPLETE', `Deployment manifest lacks artifact identity for '${contract.logicalId}'`);
    }
  }
  if (manifest.type === 'protocol-deployment-manifest/v2') {
    if (manifest.externalContracts.length === 0) {
      throw new ConfigError('MANIFEST_INCOMPLETE', 'V2 manifest must contain at least one verified external dependency');
    }
    const ids = new Set(manifest.contracts.map((contract) => contract.logicalId));
    for (const dependency of manifest.externalContracts) {
      if (!dependency.logicalId || !dependency.address || !dependency.observedAt.blockHash || !dependency.observedAt.blockNumber || !dependency.observedRuntimeCodeKeccak256 || !dependency.artifact.artifactName || !dependency.artifact.runtimeBytecodeSha256) {
        throw new ConfigError('MANIFEST_INCOMPLETE', 'Manifest contains an incomplete external contract verification fact');
      }
      if (ids.has(dependency.logicalId)) throw new ConfigError('MANIFEST_DUPLICATE_CONTRACT_ID', `Logical contract '${dependency.logicalId}' appears more than once or as both deployed and external`);
      ids.add(dependency.logicalId);
    }
  }
}

/**
 * Registry handoff is allowed only from a complete, verified deployment.
 * Selection remains the registry operator's responsibility; this gate only
 * prevents incomplete or internally inconsistent evidence from being emitted.
 */
export function validateManifestForRegistryCandidate(manifest: DeploymentManifest): void {
  assertManifestVerified(manifest);
}
