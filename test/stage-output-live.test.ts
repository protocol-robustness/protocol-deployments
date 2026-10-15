import { describe, expect, it } from 'vitest';
import { verifyStageOutputDeploymentFact } from '../src/deployment/stage-output-live';
import type { BundleConsumer } from '../src/artifacts/bundle';
import type { RpcTransport } from '../src/runtime/transport';
import type { ResolvedContract } from '../src/canonical';
import { artifactIdentityOf } from '../src/deployment/record';

const address = `0x${'11'.repeat(20)}` as `0x${string}`;
const txHash = `0x${'22'.repeat(32)}` as `0x${string}`;
const blockHash = `0x${'33'.repeat(32)}` as `0x${string}`;

const contract = {
  logicalId: 'prf/test-contract',
  scope: 'prf',
  artifactSource: 'prf/deployables',
  artifactName: 'TestContract',
  artifact: {
    source: 'prf/deployables', package: '@prf/deployables', version: '1.0.0', artifactName: 'TestContract',
    abiSha256: '44'.repeat(32), creationBytecodeSha256: '55'.repeat(32), deployedBytecodeSha256: '66'.repeat(32),
  },
  parameters: [],
  relationships: [],
  deploymentOrder: 0,
  deploymentKind: 'external',
  externalAddress: address,
  governedByGroups: [],
} as unknown as ResolvedContract;

const artifact = {
  abi: [], bytecode: '0x6001', deployedBytecode: '0x6000',
  deployedLinkReferences: {}, immutableReferences: {},
};

function fixture() {
  const receipt = {
    status: 'success', contractAddress: address, blockNumber: 7n,
  };
  const transport = {
    getChainId: async () => 31337,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ number: 7n, hash: blockHash }),
    getCode: async () => '0x6000',
  } as unknown as RpcTransport;
  const bundle = {
    loadArtifact: () => ({ artifact }),
  } as unknown as BundleConsumer;
  const expectedArtifact = artifactIdentityOf(contract);
  const value = {
    logicalId: contract.logicalId,
    address,
    transactionHash: txHash,
    blockNumber: '7',
    blockHash,
    runtimeBytecodeSha256: expectedArtifact.runtimeBytecodeSha256,
    artifact: expectedArtifact,
  };
  return { transport, bundle, expectedArtifact, value, receipt };
}

describe('live stage-output deployment verification', () => {
  it('requires matching chain, successful creation receipt, canonical block and pinned runtime at historical and current state', async () => {
    const f = fixture();
    const verify = () => verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId,
      value: f.value,
      contract,
      expectedArtifact: f.expectedArtifact,
      bundle: f.bundle,
      transport: f.transport,
      expectedChainId: 31337,
    });
    await expect(verify()).resolves.toBe(true);
    await expect(verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId, value: f.value, contract, expectedArtifact: f.expectedArtifact,
      bundle: f.bundle, transport: { ...f.transport, getChainId: async () => 1 } as RpcTransport, expectedChainId: 31337,
    })).resolves.toBe(false);
    await expect(verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId, value: { ...f.value, blockHash: `0x${'99'.repeat(32)}` }, contract,
      expectedArtifact: f.expectedArtifact, bundle: f.bundle, transport: f.transport, expectedChainId: 31337,
    })).resolves.toBe(false);
    await expect(verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId, value: f.value, contract, expectedArtifact: f.expectedArtifact, bundle: f.bundle,
      transport: { ...f.transport, getTransactionReceipt: async () => ({ ...f.receipt, status: 'reverted' }) } as unknown as RpcTransport,
      expectedChainId: 31337,
    })).resolves.toBe(false);
    await expect(verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId, value: f.value, contract, expectedArtifact: f.expectedArtifact, bundle: f.bundle,
      transport: { ...f.transport, getTransactionReceipt: async () => ({ ...f.receipt, contractAddress: `0x${'99'.repeat(20)}` }) } as unknown as RpcTransport,
      expectedChainId: 31337,
    })).resolves.toBe(false);
    await expect(verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId, value: f.value, contract, expectedArtifact: f.expectedArtifact, bundle: f.bundle,
      transport: { ...f.transport, getCode: async (_address: string, blockNumber?: bigint) => blockNumber === undefined ? '0x6000' : '0x6001' } as unknown as RpcTransport,
      expectedChainId: 31337,
    })).resolves.toBe(false);
    await expect(verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId, value: f.value, contract, expectedArtifact: f.expectedArtifact, bundle: f.bundle,
      transport: { ...f.transport, getCode: async () => '0x6001' } as unknown as RpcTransport,
      expectedChainId: 31337,
    })).resolves.toBe(false);
    await expect(verifyStageOutputDeploymentFact({
      logicalId: contract.logicalId, value: { ...f.value, artifact: { ...f.expectedArtifact, version: '2.0.0' } }, contract,
      expectedArtifact: f.expectedArtifact, bundle: f.bundle, transport: f.transport, expectedChainId: 31337,
    })).resolves.toBe(false);
  });
});
