import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import {
  registryBindingCandidate,
  validateManifestForRegistryCandidate,
  type DeploymentManifestV1,
} from '../src/deployment/manifest';

const artifact = {
  source: 'prf/deployables',
  package: '@protocol-robustness/prf-evm-deployables',
  version: '0.1.0',
  artifactName: 'OnchainShortfallReserveV1',
  abiSha256: 'a'.repeat(64),
  creationBytecodeSha256: 'b'.repeat(64),
  runtimeBytecodeSha256: 'c'.repeat(64),
};

function manifest(overrides: Partial<DeploymentManifestV1> = {}): DeploymentManifestV1 {
  return {
    type: 'protocol-deployment-manifest/v1',
    architectureSpecHash: '0xarchitecture',
    executionSpecHash: '0xexecution',
    deploymentId: 'deployment-1',
    chain: { id: 31337, blockNumber: '12', blockHash: ('0x' + 'd'.repeat(64)) as Hex },
    deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    contracts: [{
      logicalId: 'prf/shortfall-reserve',
      address: '0x0000000000000000000000000000000000000001',
      artifact,
      deploymentTx: ('0x' + '1'.repeat(64)) as Hex,
      blockNumber: '10',
    }],
    bootstrapActions: [{ id: 'bind', status: 'verified', transactionHash: ('0x' + '2'.repeat(64)) as Hex, blockNumber: '11' }],
    finalAssertions: [{ id: 'bound', status: 'passed', verifiedAt: '2026-01-01T00:00:00.000Z' }],
    ...overrides,
  };
}

describe('registry candidate consistency gate', () => {
  it('accepts complete verified evidence and applies root selection', () => {
    const candidate = registryBindingCandidate(manifest(), ['prf/shortfall-reserve'], true);
    expect(candidate.localOnly).toBe(true);
    expect(candidate.candidateRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(candidate.projection).toEqual({ type: 'deployment-manifest-roots/v1', registryRoots: ['prf/shortfall-reserve'] });
    expect(candidate.roots).toHaveLength(1);
    expect(candidate.roots[0]?.logicalId).toBe('prf/shortfall-reserve');
  });

  it('rejects unverified bootstrap actions', () => {
    expect(() => validateManifestForRegistryCandidate(manifest({
      bootstrapActions: [{ id: 'bind', status: 'submitted' }],
    }))).toThrow('unverified bootstrap actions');
  });

  it('rejects failed final assertions', () => {
    expect(() => validateManifestForRegistryCandidate(manifest({
      finalAssertions: [{ id: 'bound', status: 'failed', verifiedAt: '2026-01-01T00:00:00.000Z' }],
    }))).toThrow('failed final assertions');
  });

  it('rejects a selected root absent from the manifest', () => {
    expect(() => registryBindingCandidate(manifest(), ['prf/missing-root'])).toThrow('not present in the deployment manifest');
  });
});
