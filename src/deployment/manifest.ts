import type { Address, Hex } from 'viem';
import { canonicalJson } from '../canonical-json';
import { keccak256Hex } from '../artifacts/hash';
import type { DeploymentRecord } from './record';

export const DEPLOYMENT_MANIFEST_DOMAIN = 'protocol-deployment-manifest:v1:';
export const REGISTRY_CANDIDATE_DOMAIN = 'registry-binding-candidate:v1:';

/** Immutable evidence emitted only after every bootstrap step and assertion verifies. */
export interface DeploymentManifestV1 {
  type: 'protocol-deployment-manifest/v1';
  architectureSpecHash: string;
  executionSpecHash: string;
  deploymentId: string;
  chain: { id: number; blockNumber: string; blockHash?: Hex };
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
  verificationRoot: string;
}

export function computeManifestRoot(manifest: DeploymentManifestV1): string {
  return `0x${keccak256Hex(`${DEPLOYMENT_MANIFEST_DOMAIN}${canonicalJson(manifest)}`)}`;
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

export function registryBindingCandidate(manifest: DeploymentManifestV1, registryRoots: string[] = [], localOnly = false): RegistryBindingCandidateV1 {
  validateManifestForRegistryCandidate(manifest);
  const selected = registryRoots.length === 0
    ? manifest.contracts
    : registryRoots.map((logicalId) => {
      const contract = manifest.contracts.find((candidate) => candidate.logicalId === logicalId);
      if (!contract) throw new Error(`Registry root '${logicalId}' is not present in the deployment manifest`);
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
 * Registry handoff is allowed only from a complete, verified deployment.
 * Selection remains the registry operator's responsibility; this gate only
 * prevents incomplete or internally inconsistent evidence from being emitted.
 */
export function validateManifestForRegistryCandidate(manifest: DeploymentManifestV1): void {
  if (manifest.contracts.length === 0) throw new Error('Cannot create registry candidate from an empty deployment manifest');
  if (manifest.bootstrapActions.some((action) => action.status !== 'verified')) {
    throw new Error('Cannot create registry candidate with unverified bootstrap actions');
  }
  if (manifest.finalAssertions.some((assertion) => assertion.status !== 'passed')) {
    throw new Error('Cannot create registry candidate with failed final assertions');
  }
  for (const contract of manifest.contracts) {
    if (!contract.logicalId || !contract.address || !contract.deploymentTx || !contract.blockNumber) {
      throw new Error('Cannot create registry candidate with an incomplete deployment fact');
    }
    if (!contract.artifact.artifactName || !contract.artifact.runtimeBytecodeSha256) {
      throw new Error(`Cannot create registry candidate without artifact identity for '${contract.logicalId}'`);
    }
  }
}
