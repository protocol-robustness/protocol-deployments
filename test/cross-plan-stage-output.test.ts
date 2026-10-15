import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import { keccak256Hex } from '../src/artifacts/hash';
import { readSuccessorDeploymentPlan, validateSuccessorDeploymentPlan } from '../src/deployment/successor-plan';
import { computeManifestRoot, type DeploymentManifestV1 } from '../src/deployment/manifest';
import { deploymentPlanHash, planExecutionRoot } from '../src/deployment/plan-execution';
import { stageOutputValueRoot } from '../src/deployment/stage-output';
import { createCrossPlanStageOutputEvidence, crossPlanStageOutputEvidenceRoot, verifyCrossPlanStageOutput } from '../src/deployment/cross-plan-stage-output';

const planPath = 'config/pro-rata-v2-entitlement/successor-fork.plan.v1.json';
const basePlan = readSuccessorDeploymentPlan(planPath);
const address = `0x${'11'.repeat(20)}` as `0x${string}`;
const tx = `0x${'22'.repeat(32)}` as `0x${string}`;
const blockHash = `0x${'33'.repeat(32)}` as `0x${string}`;
const artifact = {
  source: 'prf/deployables', package: '@protocol-robustness/prf-evm-deployables', version: '0.4.0',
  artifactName: 'LocalToken', abiSha256: '44'.repeat(32), creationBytecodeSha256: '55'.repeat(32), runtimeBytecodeSha256: '66'.repeat(32),
};
const outputValue = {
  logicalId: 'prf/local-token', address, transactionHash: tx, blockNumber: '7', blockHash,
  runtimeBytecodeSha256: artifact.runtimeBytecodeSha256, artifact,
};

function hash(domain: string, body: unknown): string { return `0x${keccak256Hex(`${domain}${canonicalJson(body)}`)}`; }

function evidenceFixture(overrides: { stageStatus?: string; chainId?: number } = {}) {
  const producerPlan = structuredClone(basePlan);
  producerPlan.contracts = { 'prf/local-token': { kind: 'local-fixture', unit: 'prf-assurance', fixtureId: 'local-token', stage: 'deploy-local-token' } };
  producerPlan.authorizedConfigurationActions = [];
  for (const stage of producerPlan.stages) if (stage.id !== 'deploy-local-token') delete stage.contractOutputs;
  producerPlan.stages.find((s) => s.id === 'deploy-local-token')!.contractOutputs = { localToken: 'prf/local-token' };
  validateSuccessorDeploymentPlan(producerPlan);

  const manifest: DeploymentManifestV1 = {
    type: 'protocol-deployment-manifest/v1', architectureSpecHash: `0x${'77'.repeat(32)}`, executionSpecHash: `0x${'88'.repeat(32)}`,
    deploymentId: 'producer-run', chain: { id: overrides.chainId ?? 31337, blockNumber: '9', blockHash }, deployer: `0x${'99'.repeat(20)}`,
    contracts: [{ logicalId: 'prf/local-token', address, artifact, deploymentTx: tx, blockNumber: '7' }],
    bootstrapActions: [], finalAssertions: [],
  };
  const manifestRoot = computeManifestRoot(manifest);
  const stages = producerPlan.stages.map((stage) => ({
    id: stage.id, kind: stage.kind,
    status: stage.id === 'deploy-local-token' ? (overrides.stageStatus ?? 'verified') : 'not-executed',
    ...(stage.id === 'deploy-local-token' ? { outputs: { 'prf/local-token': { address, transactionHash: tx, blockNumber: '7', runtimeBytecodeSha256: artifact.runtimeBytecodeSha256 } } } : {}),
  }));
  const executionBody = {
    type: 'protocol-deployment-plan-execution/v1', planId: producerPlan.planId, planHash: deploymentPlanHash(producerPlan),
    environment: 'local', chainId: manifest.chain.id, localOnly: true,
    selectedUnits: producerPlan.selectedUnits, excludedUnits: producerPlan.excludedUnits,
    selectedContracts: Object.entries(producerPlan.contracts).map(([logicalId, source]) => ({ logicalId, ...source })),
    manifestRoot, stageOutputBindings: [], stages,
  };
  const execution = { ...executionBody, planExecutionRoot: planExecutionRoot(executionBody) };
  const verificationBody = {
    type: 'protocol-deployment-verification/v1', manifestRoot,
    chain: { id: manifest.chain.id, blockNumber: '9', blockHash },
    contracts: [{ logicalId: 'prf/local-token', address, artifactName: artifact.artifactName, result: 'passed' as const }],
    assertions: [], result: 'passed' as const,
  };
  const producerVerification = { ...verificationBody, verificationRoot: hash('protocol-deployment-verification:v1:', verificationBody) };
  const producerPlanHash = deploymentPlanHash(producerPlan);
  const outputRoot = stageOutputValueRoot(outputValue);
  const evidenceBase = {
    producerPlan, producerManifest: manifest, producerExecution: execution, producerVerification,
    producerDependencies: {}, stageId: 'deploy-local-token', outputName: 'localToken', logicalId: 'prf/local-token', deploymentBlockHash: blockHash,
  };
  const evidence = createCrossPlanStageOutputEvidence(evidenceBase);
  const consumerPlan = structuredClone(basePlan);
  delete consumerPlan.stages.find((s) => s.id === 'deploy-local-token')!.contractOutputs;
  consumerPlan.contracts['prf/local-token'] = {
    kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-local-token', output: 'localToken',
    producer: {
      planId: producerPlan.planId, planHash: producerPlanHash, executionRoot: execution.planExecutionRoot,
      manifestRoot, verificationRoot: producerVerification.verificationRoot, evidenceRoot: evidence.evidenceRoot, outputRoot, address,
    },
  };
  return { producerPlan, manifest, execution, producerVerification, evidence, consumerPlan, outputValue, outputRoot };
}

describe('cross-plan stage-output evidence', () => {
  it('authenticates a producer plan, verified execution, manifest and live observation', () => {
    const f = evidenceFixture();
    const substitutedConsumer = structuredClone(f.consumerPlan);
    const substitutedPin = (substitutedConsumer.contracts['prf/local-token'] as Extract<typeof substitutedConsumer.contracts[string], { kind: 'stage-output' }>).producer!;
    const originalConsumerHash = deploymentPlanHash(f.consumerPlan);
    substitutedPin.executionRoot = `0x${'ab'.repeat(32)}`;
    expect(deploymentPlanHash(substitutedConsumer)).not.toBe(originalConsumerHash);
    const verified = verifyCrossPlanStageOutput({ consumerPlan: f.consumerPlan, logicalId: 'prf/local-token', evidence: f.evidence, expectedChainId: 31337 });
    expect(verified.value).toEqual(f.outputValue);
    expect(verified.outputRoot).toBe(f.outputRoot);
    expect(verified.producerExecutionRoot).toBe(f.execution.planExecutionRoot);
  });

  it('rejects producer plan substitution and a receipt substituted under the same consumer pin', () => {
    const f = evidenceFixture();
    const substitutedPlan = { ...f.evidence, producerPlan: { ...f.producerPlan, selectedUnits: [...f.producerPlan.selectedUnits].reverse() } };
    const { evidenceRoot: _old, ...body } = substitutedPlan;
    const resealedPlan = { ...body, evidenceRoot: crossPlanStageOutputEvidenceRoot(body) };
    const consumerForSubstitutedPlan = structuredClone(f.consumerPlan);
    (consumerForSubstitutedPlan.contracts['prf/local-token'] as Extract<typeof consumerForSubstitutedPlan.contracts[string], { kind: 'stage-output' }>).producer!.evidenceRoot = resealedPlan.evidenceRoot;
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: consumerForSubstitutedPlan, logicalId: 'prf/local-token', evidence: resealedPlan })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_IDENTITY_MISMATCH' }));
    const { planExecutionRoot: _oldExecutionRoot, ...executionBody } = f.execution;
    const changedExecutionBody = { ...executionBody, environment: 'substituted-environment' };
    const substitutedExecution = { ...changedExecutionBody, planExecutionRoot: planExecutionRoot(changedExecutionBody) };
    const substitutedReceipt = { ...f.evidence, producerExecution: substitutedExecution };
    const { evidenceRoot: _oldRoot, ...receiptBody } = substitutedReceipt;
    const resealedReceipt = { ...receiptBody, evidenceRoot: crossPlanStageOutputEvidenceRoot(receiptBody) };
    const consumerForSubstitutedReceipt = structuredClone(f.consumerPlan);
    (consumerForSubstitutedReceipt.contracts['prf/local-token'] as Extract<typeof consumerForSubstitutedReceipt.contracts[string], { kind: 'stage-output' }>).producer!.evidenceRoot = resealedReceipt.evidenceRoot;
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: consumerForSubstitutedReceipt, logicalId: 'prf/local-token', evidence: resealedReceipt })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_EXECUTION_MISMATCH' }));
  });

  it('rejects output substitution, wrong-chain identity, incomplete execution and missing evidence', () => {
    const f = evidenceFixture();
    const alteredOutput = { ...f.evidence, deploymentBlockHash: `0x${'ee'.repeat(32)}` };
    const { evidenceRoot: _oldOutputRoot, ...outputBody } = alteredOutput;
    const resealedOutput = { ...outputBody, evidenceRoot: crossPlanStageOutputEvidenceRoot(outputBody) };
    const changedConsumer = structuredClone(f.consumerPlan);
    (changedConsumer.contracts['prf/local-token'] as Extract<typeof changedConsumer.contracts[string], { kind: 'stage-output' }>).producer!.evidenceRoot = resealedOutput.evidenceRoot;
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: changedConsumer, logicalId: 'prf/local-token', evidence: resealedOutput })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_OUTPUT_SUBSTITUTION' }));
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: f.consumerPlan, logicalId: 'prf/local-token', evidence: f.evidence, expectedChainId: 1 })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_CHAIN_MISMATCH' }));
    const wrongExecutionChainBody = { ...f.execution, chainId: 1 };
    const { planExecutionRoot: _oldRoot, ...wrongExecutionBody } = wrongExecutionChainBody;
    const wrongExecution = { ...wrongExecutionBody, planExecutionRoot: planExecutionRoot(wrongExecutionBody) };
    const wrongChainEvidenceBody = { ...f.evidence, producerExecution: wrongExecution };
    const { evidenceRoot: _oldEvidenceRoot, ...wrongChainBody } = wrongChainEvidenceBody;
    const wrongChainEvidence = { ...wrongChainBody, evidenceRoot: crossPlanStageOutputEvidenceRoot(wrongChainBody) };
    const wrongChainConsumer = structuredClone(f.consumerPlan);
    (wrongChainConsumer.contracts['prf/local-token'] as Extract<typeof wrongChainConsumer.contracts[string], { kind: 'stage-output' }>).producer!.evidenceRoot = wrongChainEvidence.evidenceRoot;
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: wrongChainConsumer, logicalId: 'prf/local-token', evidence: wrongChainEvidence })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_EXECUTION_CONTEXT_MISMATCH' }));
    const incomplete = evidenceFixture({ stageStatus: 'pending' });
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: incomplete.consumerPlan, logicalId: 'prf/local-token', evidence: incomplete.evidence })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_PRODUCER_STAGE_INCOMPLETE' }));
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: f.consumerPlan, logicalId: 'prf/local-token', evidence: undefined })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_INVALID' }));
  });

  it('rejects incomplete output maps, changed verification evidence and dependency cycles', () => {
    const f = evidenceFixture();
    const changedVerification = { ...f.evidence, producerVerification: { ...f.producerVerification, chain: { ...f.producerVerification.chain, id: 1 } } };
    const { evidenceRoot: _oldVerificationRoot, ...verificationBody } = changedVerification;
    const resealedVerification = { ...verificationBody, evidenceRoot: crossPlanStageOutputEvidenceRoot(verificationBody) };
    const changedConsumer = structuredClone(f.consumerPlan);
    (changedConsumer.contracts['prf/local-token'] as Extract<typeof changedConsumer.contracts[string], { kind: 'stage-output' }>).producer!.evidenceRoot = resealedVerification.evidenceRoot;
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: changedConsumer, logicalId: 'prf/local-token', evidence: resealedVerification })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_VERIFICATION_MISMATCH' }));
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: f.consumerPlan, logicalId: 'prf/local-token', evidence: f.evidence, ancestorPlanHashes: [deploymentPlanHash(f.producerPlan)] })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_CYCLE' }));
    const noMap = structuredClone(f.producerPlan);
    delete noMap.stages.find((stage) => stage.id === 'deploy-local-token')!.contractOutputs;
    const tampered = { ...f.evidence, producerPlan: noMap };
    const { evidenceRoot: _oldMapRoot, ...mapBody } = tampered;
    const resealedMap = { ...mapBody, evidenceRoot: crossPlanStageOutputEvidenceRoot(mapBody) };
    const consumerWithNewPin = structuredClone(f.consumerPlan);
    const producerPin = (consumerWithNewPin.contracts['prf/local-token'] as Extract<typeof consumerWithNewPin.contracts[string], { kind: 'stage-output' }>).producer!;
    producerPin.planHash = deploymentPlanHash(noMap);
    producerPin.evidenceRoot = resealedMap.evidenceRoot;
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: consumerWithNewPin, logicalId: 'prf/local-token', evidence: resealedMap })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_UNDECLARED' }));
  });
});
