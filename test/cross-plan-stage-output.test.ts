import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalJson } from '../src/canonical-json';
import { keccak256Hex } from '../src/artifacts/hash';
import { readSuccessorDeploymentPlan, validateSuccessorDeploymentPlan, type SuccessorDeploymentPlanV1 } from '../src/deployment/successor-plan';
import { computeManifestRoot, type DeploymentManifest, type DeploymentManifestV1 } from '../src/deployment/manifest';
import { deploymentPlanHash, planExecutionRoot } from '../src/deployment/plan-execution';
import { stageOutputValueRoot, stageOutputValuesForPlan } from '../src/deployment/stage-output';
import {
  createCrossPlanStageOutputEvidence, crossPlanStageOutputEvidenceRoot, readCrossPlanStageOutputEvidenceDirectory,
  verifyCrossPlanStageOutput, writeCrossPlanStageOutputEvidence, type CrossPlanStageOutputEvidenceV1,
} from '../src/deployment/cross-plan-stage-output';

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

type StageOutputSource = Extract<SuccessorDeploymentPlanV1['contracts'][string], { kind: 'stage-output' }>;
type ProducerPin = NonNullable<StageOutputSource['producer']>;

function pinOf(plan: SuccessorDeploymentPlanV1, logicalId: string): ProducerPin {
  const source = plan.contracts[logicalId];
  if (!source || source.kind !== 'stage-output' || !source.producer) throw new Error(`'${logicalId}' is not a pinned cross-plan source`);
  return source.producer;
}

/** Re-seal an evidence package after a tamper so only the intended check can fail. */
function reseal(evidence: CrossPlanStageOutputEvidenceV1, patch: Partial<CrossPlanStageOutputEvidenceV1> = {}): CrossPlanStageOutputEvidenceV1 {
  const { evidenceRoot: _retained, ...body } = { ...evidence, ...patch };
  return { ...body, evidenceRoot: crossPlanStageOutputEvidenceRoot(body) };
}

function consumerWithPin(plan: SuccessorDeploymentPlanV1, mutate: (pin: ProducerPin) => void): SuccessorDeploymentPlanV1 {
  const consumer = structuredClone(plan);
  mutate(pinOf(consumer, 'prf/local-token'));
  return consumer;
}

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
    ...(stage.id === 'deploy-local-token' ? { outputs: { localToken: { address, transactionHash: tx, blockNumber: '7', runtimeBytecodeSha256: artifact.runtimeBytecodeSha256 } } } : {}),
  }));
  const executionBody = {
    type: 'protocol-deployment-plan-execution/v1', executionStatus: 'partial', planId: producerPlan.planId, planHash: deploymentPlanHash(producerPlan),
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
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: wrongChainConsumer, logicalId: 'prf/local-token', evidence: wrongChainEvidence })).toThrow(expect.objectContaining({ code: 'PLAN_EXECUTION_CONTEXT_MISMATCH' }));
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
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: consumerWithNewPin, logicalId: 'prf/local-token', evidence: resealedMap })).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_PLAN_CONTRACT_OUTPUT' }));
  });
});

const nestedAddress = `0x${'44'.repeat(20)}` as `0x${string}`;
const nestedTx = `0x${'55'.repeat(32)}` as `0x${string}`;

interface DeploymentValue {
  logicalId: string;
  address: `0x${string}`;
  transactionHash: `0x${string}`;
  blockNumber: string;
  blockHash: `0x${string}`;
  runtimeBytecodeSha256: string;
  artifact: typeof artifact;
}

interface NestedDependency {
  logicalId: string;
  stage: string;
  output: string;
  evidence: CrossPlanStageOutputEvidenceV1;
  value: DeploymentValue;
}

interface ProducerBundle {
  plan: SuccessorDeploymentPlanV1;
  manifest: DeploymentManifest;
  executionRoot: string;
  verificationRoot: string;
  evidence: CrossPlanStageOutputEvidenceV1;
  value: DeploymentValue;
  outputRoot: string;
}

/** Build one producer's retained plan/manifest/execution/verification/evidence chain. */
function buildProducer(opts: {
  contracts: SuccessorDeploymentPlanV1['contracts'];
  contractOutputs: Record<string, string>;
  deployValue: DeploymentValue;
  nested?: NestedDependency[];
  chainId?: number;
  stageStatus?: string;
}): ProducerBundle {
  const plan = structuredClone(basePlan);
  plan.authorizedConfigurationActions = [];
  for (const stage of plan.stages) if (stage.id !== 'deploy-local-token') delete stage.contractOutputs;
  plan.stages.find((stage) => stage.id === 'deploy-local-token')!.contractOutputs = { ...opts.contractOutputs };
  plan.contracts = opts.contracts;
  validateSuccessorDeploymentPlan(plan);

  const chainId = opts.chainId ?? 31337;
  const nested = opts.nested ?? [];
  const manifest = {
    type: nested.length > 0 ? 'protocol-deployment-manifest/v2' : 'protocol-deployment-manifest/v1',
    architectureSpecHash: `0x${'77'.repeat(32)}`, executionSpecHash: `0x${'88'.repeat(32)}`,
    deploymentId: 'producer-run', chain: { id: chainId, blockNumber: '9', blockHash },
    deployer: `0x${'99'.repeat(20)}`,
    contracts: [{ logicalId: opts.deployValue.logicalId, address: opts.deployValue.address, artifact, deploymentTx: opts.deployValue.transactionHash, blockNumber: opts.deployValue.blockNumber }],
    bootstrapActions: [], finalAssertions: [],
    ...(nested.length > 0 ? {
      externalContracts: nested.map((dependency) => ({
        logicalId: dependency.logicalId, address: dependency.value.address, artifact: dependency.value.artifact,
        observedRuntimeCodeKeccak256: `0x${'ab'.repeat(32)}`,
        observedAt: { blockNumber: dependency.value.blockNumber, blockHash: dependency.value.blockHash },
      })),
    } : {}),
  } as unknown as DeploymentManifest;
  const manifestRoot = computeManifestRoot(manifest);
  const stages = plan.stages.map((stage) => ({
    id: stage.id, kind: stage.kind,
    status: stage.id === 'deploy-local-token' ? (opts.stageStatus ?? 'verified') : 'not-executed',
    ...(stage.id === 'deploy-local-token' ? {
      outputs: { [Object.entries(stage.contractOutputs ?? {}).find(([, logicalId]) => logicalId === opts.deployValue.logicalId)?.[0] ?? opts.deployValue.logicalId]: { address: opts.deployValue.address, transactionHash: opts.deployValue.transactionHash, blockNumber: opts.deployValue.blockNumber, runtimeBytecodeSha256: artifact.runtimeBytecodeSha256 } },
    } : {}),
  }));
  const executionBody = {
    type: 'protocol-deployment-plan-execution/v1', executionStatus: 'partial', planId: plan.planId, planHash: deploymentPlanHash(plan),
    environment: 'local', chainId, localOnly: plan.localOnly,
    selectedUnits: plan.selectedUnits, excludedUnits: plan.excludedUnits,
    selectedContracts: Object.entries(plan.contracts).map(([logicalId, source]) => ({ logicalId, ...source })),
    manifestRoot,
    stageOutputBindings: nested.map((dependency) => ({
      logicalId: dependency.logicalId, stage: dependency.stage, output: dependency.output,
      evidenceRoot: dependency.evidence.evidenceRoot, outputRoot: stageOutputValueRoot(dependency.value), address: dependency.value.address,
    })),
    stages,
  };
  const executionRoot = planExecutionRoot(executionBody);
  const verificationBody = {
    type: 'protocol-deployment-verification/v1', manifestRoot,
    chain: { id: chainId, blockNumber: '9', blockHash },
    contracts: [{ logicalId: opts.deployValue.logicalId, address: opts.deployValue.address, artifactName: artifact.artifactName, result: 'passed' as const }],
    assertions: [], result: 'passed' as const,
  };
  const verificationRoot = hash('protocol-deployment-verification:v1:', verificationBody);
  const evidence = createCrossPlanStageOutputEvidence({
    producerPlan: plan, producerManifest: manifest, producerExecution: { ...executionBody, planExecutionRoot: executionRoot },
    producerVerification: { ...verificationBody, verificationRoot },
    producerDependencies: Object.fromEntries(nested.map((dependency) => [dependency.logicalId, dependency.evidence])),
    stageId: 'deploy-local-token', outputName: 'localToken', logicalId: opts.deployValue.logicalId, deploymentBlockHash: blockHash,
  });
  return { plan, manifest, executionRoot, verificationRoot, evidence, value: opts.deployValue, outputRoot: stageOutputValueRoot(opts.deployValue) };
}

function producerPinOf(bundle: ProducerBundle): ProducerPin {
  return {
    planId: bundle.plan.planId, planHash: deploymentPlanHash(bundle.plan), executionRoot: bundle.executionRoot,
    manifestRoot: computeManifestRoot(bundle.manifest), verificationRoot: bundle.verificationRoot,
    evidenceRoot: bundle.evidence.evidenceRoot, outputRoot: bundle.outputRoot, address: bundle.value.address,
  };
}

/** Consumer -> producer -> upstream producer, so the upstream proof must verify recursively. */
function nestedFixture(opts: { nestedChainId?: number } = {}) {
  const upstreamValue: DeploymentValue = {
    logicalId: 'prf/nested-token', address: nestedAddress, transactionHash: nestedTx, blockNumber: '11', blockHash,
    runtimeBytecodeSha256: artifact.runtimeBytecodeSha256, artifact,
  };
  const upstream = buildProducer({
    contracts: { 'prf/nested-token': { kind: 'local-fixture', unit: 'prf-assurance', fixtureId: 'local-snapshot-token-v1', stage: 'deploy-local-token' } },
    contractOutputs: { localToken: 'prf/nested-token' },
    deployValue: upstreamValue,
    chainId: opts.nestedChainId ?? 31337,
  });
  const producerContracts: SuccessorDeploymentPlanV1['contracts'] = {
    'prf/local-token': { kind: 'local-fixture', unit: 'protected-operations', fixtureId: 'local-snapshot-token-v1', stage: 'deploy-local-token' },
    'prf/nested-token': {
      kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-local-token', output: 'localToken',
      producer: producerPinOf(upstream),
    },
  };
  const producer = buildProducer({
    contracts: producerContracts,
    contractOutputs: { localToken: 'prf/local-token' },
    deployValue: { logicalId: 'prf/local-token', address, transactionHash: tx, blockNumber: '7', blockHash, runtimeBytecodeSha256: artifact.runtimeBytecodeSha256, artifact },
    nested: [{ logicalId: 'prf/nested-token', stage: 'deploy-local-token', output: 'localToken', evidence: upstream.evidence, value: upstream.value }],
  });
  const consumerPlan = structuredClone(basePlan);
  delete consumerPlan.stages.find((stage) => stage.id === 'deploy-local-token')!.contractOutputs;
  consumerPlan.contracts['prf/local-token'] = {
    kind: 'stage-output', unit: 'protected-operations', stage: 'deploy-local-token', output: 'localToken',
    producer: producerPinOf(producer),
  };
  return { upstream, producer, consumerPlan };
}

describe('cross-plan evidence gaps', () => {
  it('rejects an unpinned contract, a tampered evidence root and a local-only producer consumed publicly', () => {
    const f = evidenceFixture();
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: f.consumerPlan, logicalId: 'prf/genesis', evidence: f.evidence, expectedChainId: 31337 }))
      .toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_NOT_PINNED' }));
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: f.consumerPlan, logicalId: 'prf/local-token', evidence: { ...f.evidence, evidenceRoot: `0x${'ab'.repeat(32)}` }, expectedChainId: 31337 }))
      .toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_ROOT_MISMATCH' }));
    expect(() => verifyCrossPlanStageOutput({ consumerPlan: { ...f.consumerPlan, localOnly: false }, logicalId: 'prf/local-token', evidence: f.evidence, expectedChainId: 31337 }))
      .toThrow(expect.objectContaining({ code: 'CROSS_PLAN_LOCAL_ONLY_DEPENDENCY' }));
  });

  it('rejects a substituted manifest, a malformed producer plan and verification report gaps', () => {
    const f = evidenceFixture();
    const substitutedManifest = reseal(f.evidence, { producerManifest: { ...f.manifest, deploymentId: 'substituted-run' } });
    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: consumerWithPin(f.consumerPlan, (pin) => { pin.evidenceRoot = substitutedManifest.evidenceRoot; }),
      logicalId: 'prf/local-token', evidence: substitutedManifest, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_MANIFEST_MISMATCH' }));

    const malformedPlan = reseal(f.evidence, { producerPlan: { ...f.producerPlan, stages: 'not-a-stage-list' } });
    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: consumerWithPin(f.consumerPlan, (pin) => { pin.evidenceRoot = malformedPlan.evidenceRoot; }),
      logicalId: 'prf/local-token', evidence: malformedPlan, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_PRODUCER_PLAN_INVALID' }));

    const failedVerification = reseal(f.evidence, { producerVerification: { ...f.producerVerification, result: 'failed' } });
    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: consumerWithPin(f.consumerPlan, (pin) => { pin.evidenceRoot = failedVerification.evidenceRoot; }),
      logicalId: 'prf/local-token', evidence: failedVerification, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_VERIFICATION_INVALID' }));

    const { verificationRoot: _dropped, ...verificationBody } = f.producerVerification;
    const emptyVerification = { ...verificationBody, contracts: [] };
    const resealedVerification = { ...emptyVerification, verificationRoot: hash('protocol-deployment-verification:v1:', emptyVerification) };
    const withoutContract = reseal(f.evidence, { producerVerification: resealedVerification });
    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: consumerWithPin(f.consumerPlan, (pin) => { pin.evidenceRoot = withoutContract.evidenceRoot; }),
      logicalId: 'prf/local-token', evidence: withoutContract, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_VERIFICATION_CONTRACT_MISSING' }));

    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: consumerWithPin(f.consumerPlan, (pin) => { pin.verificationRoot = `0x${'cd'.repeat(32)}`; }),
      logicalId: 'prf/local-token', evidence: f.evidence, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_VERIFICATION_ROOT_MISMATCH' }));
  });

  it('refuses to project a pinned cross-plan output without producer evidence', () => {
    const f = evidenceFixture();
    expect(() => stageOutputValuesForPlan(f.consumerPlan, {}, {}))
      .toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_REQUIRED' }));
  });

  it('rejects a missing evidence directory, duplicate packages and a conflicting immutable write', () => {
    const missing = path.join(os.tmpdir(), `prf-cross-plan-missing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    expect(() => readCrossPlanStageOutputEvidenceDirectory(missing))
      .toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_DIRECTORY_MISSING' }));

    const f = evidenceFixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-cross-plan-'));
    try {
      writeCrossPlanStageOutputEvidence(directory, f.evidence);
      const duplicate = reseal(f.evidence, { deploymentBlockHash: `0x${'ef'.repeat(32)}` });
      writeCrossPlanStageOutputEvidence(directory, duplicate);
      expect(() => readCrossPlanStageOutputEvidenceDirectory(directory))
        .toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_DUPLICATE' }));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    const conflictDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-cross-plan-conflict-'));
    try {
      const occupied = path.join(conflictDirectory, `${encodeURIComponent(f.evidence.logicalId)}.${f.evidence.evidenceRoot.slice(2, 14)}.cross-plan-stage-output.v1.json`);
      fs.writeFileSync(occupied, 'occupied by an earlier writer\n');
      expect(() => writeCrossPlanStageOutputEvidence(conflictDirectory, f.evidence))
        .toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_EXISTS_CONFLICT' }));
    } finally {
      fs.rmSync(conflictDirectory, { recursive: true, force: true });
    }
  });
});

describe('nested cross-plan producer evidence', () => {
  it('verifies a producer whose own pinned upstream dependency verifies recursively', () => {
    const f = nestedFixture();
    const verified = verifyCrossPlanStageOutput({ consumerPlan: f.consumerPlan, logicalId: 'prf/local-token', evidence: f.producer.evidence, expectedChainId: 31337 });
    expect(verified.value).toEqual(f.producer.value);
    expect(verified.outputRoot).toBe(f.producer.outputRoot);
    expect(verified.producerPlanHash).toBe(deploymentPlanHash(f.producer.plan));
    expect(verified.chainId).toBe(31337);
  });

  it('rejects an omitted upstream dependency, an upstream deployed on another chain and substituted upstream evidence', () => {
    const f = nestedFixture();
    const withoutUpstream = reseal(f.producer.evidence, { producerDependencies: {} });
    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: consumerWithPin(f.consumerPlan, (pin) => { pin.evidenceRoot = withoutUpstream.evidenceRoot; }),
      logicalId: 'prf/local-token', evidence: withoutUpstream, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_DEPENDENCIES_MISSING' }));

    const wrongUpstreamChain = nestedFixture({ nestedChainId: 8453 });
    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: wrongUpstreamChain.consumerPlan, logicalId: 'prf/local-token',
      evidence: wrongUpstreamChain.producer.evidence, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_CHAIN_MISMATCH' }));

    const substitutedUpstream = reseal(f.upstream.evidence, { deploymentBlockHash: `0x${'ee'.repeat(32)}` });
    const producerWithSubstitutedUpstream = reseal(f.producer.evidence, { producerDependencies: { 'prf/nested-token': substitutedUpstream } });
    expect(() => verifyCrossPlanStageOutput({
      consumerPlan: consumerWithPin(f.consumerPlan, (pin) => { pin.evidenceRoot = producerWithSubstitutedUpstream.evidenceRoot; }),
      logicalId: 'prf/local-token', evidence: producerWithSubstitutedUpstream, expectedChainId: 31337,
    })).toThrow(expect.objectContaining({ code: 'CROSS_PLAN_STAGE_OUTPUT_ROOT_MISMATCH' }));
  });
});
