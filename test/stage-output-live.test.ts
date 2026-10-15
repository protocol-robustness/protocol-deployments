import { describe, expect, it } from 'vitest';
import { mayRetainCommittedAuxiliaryOutput, verifyStageOutputContractFact, verifyStageOutputDeploymentFact } from '../src/deployment/stage-output-live';
import type { BundleConsumer } from '../src/artifacts/bundle';
import type { RpcTransport } from '../src/runtime/transport';
import type { ResolvedContract } from '../src/canonical';
import { artifactIdentityOf } from '../src/deployment/record';
import type { SuccessorDeploymentPlanV1 } from '../src/deployment/successor-plan';

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
  deploymentKind: 'deployment',
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

  it('live-checks contract facts from ordinary deploy sources and binds selected stage outputs by exact output name', async () => {
    const f = fixture();
    const makePlan = (source: Record<string, unknown>) => ({
      planId: 'prf/controlled-shortfall-successor-fork.v1',
      stages: [{ id: 'deploy', kind: 'deploy', dependsOn: [], consumes: {}, produces: ['adapter', 'other'] }],
      contracts: { [contract.logicalId]: source },
    } as unknown as SuccessorDeploymentPlanV1);
    const common = {
      stageId: 'deploy', value: f.value, contracts: { [contract.logicalId]: contract }, bundle: f.bundle,
      transport: f.transport, expectedChainId: 31337,
    };
    await expect(verifyStageOutputContractFact({
      ...common, plan: makePlan({ kind: 'deploy', unit: 'prf-assurance', stage: 'deploy' }), outputName: 'adapter',
    })).resolves.toEqual({ logicalId: contract.logicalId, address, selectedStageOutput: false });
    await expect(verifyStageOutputContractFact({
      ...common, plan: makePlan({ kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy', output: 'adapter' }), outputName: 'other',
    })).resolves.toBeUndefined();
    await expect(verifyStageOutputContractFact({
      ...common, plan: makePlan({ kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy', output: 'adapter' }), outputName: 'adapter',
    })).resolves.toEqual({ logicalId: contract.logicalId, address, selectedStageOutput: true });
  });

  it('retains only declared, unconsumed auxiliary values under their receipt commitment', () => {
    const plan = (consumes: Record<string, { stage: string; output: string }>) => ({
      stages: [
        { id: 'deploy', kind: 'deploy', dependsOn: [], consumes: {}, produces: ['verifierId'] },
        { id: 'configure', kind: 'authorize-configuration', dependsOn: ['deploy'], consumes, produces: [] },
      ],
      contracts: {},
    } as unknown as SuccessorDeploymentPlanV1);
    const value = `0x${'70'.repeat(32)}`;
    expect(mayRetainCommittedAuxiliaryOutput({ plan: plan({}), stageId: 'deploy', outputName: 'verifierId', value })).toBe(true);
    expect(mayRetainCommittedAuxiliaryOutput({
      plan: plan({ verifier: { stage: 'deploy', output: 'verifierId' } }), stageId: 'deploy', outputName: 'verifierId', value,
    })).toBe(false);
    expect(mayRetainCommittedAuxiliaryOutput({
      plan: plan({}), stageId: 'deploy', outputName: 'verifierId', value: { logicalId: contract.logicalId },
    })).toBe(false);
    expect(mayRetainCommittedAuxiliaryOutput({ plan: plan({}), stageId: 'deploy', outputName: 'undeclared', value })).toBe(false);
  });
});
