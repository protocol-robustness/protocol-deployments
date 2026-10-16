import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson } from '../canonical-json';
import { keccak256Hex } from '../artifacts/hash';
import { ConfigError } from '../errors';
import { assertManifestVerified, computeManifestRoot, type DeploymentManifest } from './manifest';
import { assertPlanExecutionMatchesManifest, deploymentPlanHash, planExecutionRoot } from './plan-execution';
import { stageOutputValueRoot } from './stage-output';
import type { StageOutputDeploymentFactV1 } from './stage-output-live';
import { successorDeploymentPlanSchema, validateSuccessorDeploymentPlan, type SuccessorDeploymentPlanV1 } from './successor-plan';

export const CROSS_PLAN_STAGE_OUTPUT_DOMAIN = 'protocol-deployment-cross-plan-stage-output:v1:';
export const LIVE_VERIFICATION_V1_DOMAIN = 'protocol-deployment-verification:v1:';
export const LIVE_VERIFICATION_V2_DOMAIN = 'protocol-deployment-verification:v2:';

const root = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const verificationSchema = z.object({
  type: z.enum(['protocol-deployment-verification/v1', 'protocol-deployment-verification/v2']),
  manifestRoot: root,
  chain: z.object({ id: z.number().int().positive(), blockNumber: z.string().regex(/^\d+$/), blockHash: root }),
  contracts: z.array(z.object({ logicalId: z.string(), address, artifactName: z.string(), result: z.literal('passed') }).strict()),
  assertions: z.array(z.unknown()),
  result: z.literal('passed'),
  verificationRoot: root,
}).passthrough();

export const crossPlanStageOutputEvidenceV1Schema = z.object({
  type: z.literal('protocol-deployment-cross-plan-stage-output/v1'),
  producerPlan: z.unknown(),
  producerManifest: z.unknown(),
  producerExecution: z.record(z.string(), z.unknown()),
  producerVerification: z.unknown(),
  producerDependencies: z.record(z.string(), z.unknown()),
  stageId: z.string().min(1),
  outputName: z.string().min(1),
  logicalId: z.string().min(1),
  deploymentBlockHash: root,
  evidenceRoot: root,
}).strict();

export type CrossPlanStageOutputEvidenceV1 = z.infer<typeof crossPlanStageOutputEvidenceV1Schema>;

export function crossPlanStageOutputEvidenceRoot(body: Omit<CrossPlanStageOutputEvidenceV1, 'evidenceRoot'>): string {
  return `0x${keccak256Hex(`${CROSS_PLAN_STAGE_OUTPUT_DOMAIN}${canonicalJson(body)}`)}`;
}

export function readCrossPlanStageOutputEvidenceDirectory(directory: string): Record<string, CrossPlanStageOutputEvidenceV1> {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_DIRECTORY_MISSING', `Cross-plan stage-output evidence directory '${directory}' does not exist`);
  }
  const result: Record<string, CrossPlanStageOutputEvidenceV1> = {};
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.cross-plan-stage-output.v1.json')).sort()) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')); }
    catch { throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_INVALID', `Cannot parse cross-plan evidence '${file}'`); }
    const parsed = crossPlanStageOutputEvidenceV1Schema.safeParse(raw);
    if (!parsed.success) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_INVALID', `Cross-plan evidence '${file}' is malformed`, { details: { issues: parsed.error.issues } });
    const { evidenceRoot, ...body } = parsed.data;
    if (evidenceRoot !== crossPlanStageOutputEvidenceRoot(body)) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_ROOT_MISMATCH', `Cross-plan evidence '${file}' has an invalid content root`);
    if (result[parsed.data.logicalId]) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_DUPLICATE', `Multiple cross-plan evidence packages name '${parsed.data.logicalId}'`);
    result[parsed.data.logicalId] = parsed.data;
  }
  return result;
}

export interface VerifiedCrossPlanStageOutput {
  chainId: number;
  producerPlanHash: string;
  producerExecutionRoot: string;
  producerManifestRoot: string;
  producerVerificationRoot: string;
  evidenceRoot: string;
  outputRoot: string;
  value: StageOutputDeploymentFactV1;
}

/** Build the immutable hand-off envelope from retained producer artifacts. */
export function createCrossPlanStageOutputEvidence(input: Omit<CrossPlanStageOutputEvidenceV1, 'type' | 'evidenceRoot'>): CrossPlanStageOutputEvidenceV1 {
  const body = { type: 'protocol-deployment-cross-plan-stage-output/v1' as const, ...input };
  return crossPlanStageOutputEvidenceV1Schema.parse({ ...body, evidenceRoot: crossPlanStageOutputEvidenceRoot(body) });
}

/** Persist cross-plan evidence without allowing replacement of an existing package. */
export function writeCrossPlanStageOutputEvidence(directory: string, evidence: CrossPlanStageOutputEvidenceV1): string {
  const parsed = crossPlanStageOutputEvidenceV1Schema.parse(evidence);
  const { evidenceRoot, ...body } = parsed;
  if (evidenceRoot !== crossPlanStageOutputEvidenceRoot(body)) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_ROOT_MISMATCH', 'Cannot persist cross-plan evidence with an invalid content root');
  const file = path.join(directory, `${encodeURIComponent(parsed.logicalId)}.${parsed.evidenceRoot.slice(2, 14)}.cross-plan-stage-output.v1.json`);
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  try { fs.writeFileSync(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (fs.readFileSync(file, 'utf8') !== bytes) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EXISTS_CONFLICT', `Refusing to overwrite cross-plan evidence '${file}'`);
  }
  return file;
}

/**
 * Validate the producer's retained canonical plan/manifest/execution/live
 * observation, then derive the consumed contract fact from those records.
 * The live chain check remains mandatory at the consuming CLI boundary.
 */
export function verifyCrossPlanStageOutput(input: {
  consumerPlan: SuccessorDeploymentPlanV1;
  logicalId: string;
  evidence: unknown;
  ancestorPlanHashes?: string[];
  expectedChainId?: number;
}): VerifiedCrossPlanStageOutput {
  const source = input.consumerPlan.contracts[input.logicalId];
  if (!source || source.kind !== 'stage-output' || !source.producer) {
    throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_NOT_PINNED', `Contract '${input.logicalId}' has no pinned cross-plan producer identity`);
  }
  const parsed = crossPlanStageOutputEvidenceV1Schema.safeParse(input.evidence);
  if (!parsed.success) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_INVALID', 'Cross-plan stage-output evidence is malformed', { details: { issues: parsed.error.issues } });
  const evidence = parsed.data;
  const { evidenceRoot, ...body } = evidence;
  if (evidenceRoot !== crossPlanStageOutputEvidenceRoot(body) || evidenceRoot !== source.producer.evidenceRoot) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_ROOT_MISMATCH', 'Cross-plan evidence root is invalid or differs from consumer pin');

  const producerPlanParsed = successorDeploymentPlanSchema.safeParse(evidence.producerPlan);
  if (!producerPlanParsed.success) throw new ConfigError('CROSS_PLAN_PRODUCER_PLAN_INVALID', 'Producer plan is malformed');
  const producerPlan = producerPlanParsed.data;
  validateSuccessorDeploymentPlan(producerPlan);
  const producerPlanHash = deploymentPlanHash(producerPlan);
  const ancestors = [...(input.ancestorPlanHashes ?? []), deploymentPlanHash(input.consumerPlan)];
  if (ancestors.includes(producerPlanHash)) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_CYCLE', 'Cross-plan stage-output dependency cycle detected');
  if (producerPlan.planId !== source.producer.planId || producerPlanHash !== source.producer.planHash || evidence.logicalId !== input.logicalId ||
      evidence.stageId !== source.stage || evidence.outputName !== source.output) {
    throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_IDENTITY_MISMATCH', 'Producer plan, stage, output or logical contract differs from the consumer pin');
  }
  const producerStage = producerPlan.stages.find((stage) => stage.id === evidence.stageId);
  const producerSource = producerPlan.contracts[evidence.logicalId];
  if (!producerStage || !producerStage.produces.includes(evidence.outputName) ||
      producerStage.contractOutputs?.[evidence.outputName] !== evidence.logicalId ||
      !producerSource || (producerSource.kind !== 'deploy' && producerSource.kind !== 'local-fixture') || producerSource.stage !== evidence.stageId) {
    throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_UNDECLARED', 'Producer plan does not declare this stage output as the selected contract deployment');
  }
  const nestedSources = Object.entries(producerPlan.contracts).filter(([, dependency]) => dependency.kind === 'stage-output' && dependency.producer);
  if (canonicalJson(Object.keys(evidence.producerDependencies).sort()) !== canonicalJson(nestedSources.map(([id]) => id).sort())) {
    throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_DEPENDENCIES_MISSING', 'Producer evidence omits or adds nested cross-plan dependencies');
  }
  for (const [dependencyId] of nestedSources) {
    verifyCrossPlanStageOutput({ consumerPlan: producerPlan, logicalId: dependencyId, evidence: evidence.producerDependencies[dependencyId], ancestorPlanHashes: ancestors, expectedChainId: input.expectedChainId });
  }

  const manifest = evidence.producerManifest as unknown as DeploymentManifest;
  assertManifestVerified(manifest);
  if (input.expectedChainId !== undefined && manifest.chain.id !== input.expectedChainId) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_CHAIN_MISMATCH', 'Producer deployment chain differs from consumer chain');
  if (producerPlan.localOnly && !input.consumerPlan.localOnly) throw new ConfigError('CROSS_PLAN_LOCAL_ONLY_DEPENDENCY', 'A local-only producer output cannot be consumed by a public deployment plan');
  const manifestRoot = computeManifestRoot(manifest);
  if (manifestRoot !== source.producer.manifestRoot) throw new ConfigError('CROSS_PLAN_MANIFEST_MISMATCH', 'Producer manifest root differs from consumer pin');
  const execution = evidence.producerExecution as Record<string, unknown>;
  assertPlanExecutionMatchesManifest(execution, producerPlan, manifest);
  if (execution.chainId !== manifest.chain.id || execution.localOnly !== producerPlan.localOnly) {
    throw new ConfigError('CROSS_PLAN_EXECUTION_CONTEXT_MISMATCH', 'Producer execution chain or local-only context differs from its plan and manifest');
  }
  const executionRoot = String(execution.planExecutionRoot);
  if (executionRoot !== source.producer.executionRoot || executionRoot !== planExecutionRoot(Object.fromEntries(Object.entries(execution).filter(([key]) => key !== 'planExecutionRoot')))) {
    throw new ConfigError('CROSS_PLAN_EXECUTION_MISMATCH', 'Producer execution receipt differs from consumer pin or has an invalid root');
  }
  const stages = execution.stages as Array<{ id: string; status: string; outputs?: Record<string, { address?: string; transactionHash?: string; blockNumber?: string; runtimeBytecodeSha256?: string }> }>;
  const stageReceipt = stages.find((stage) => stage.id === evidence.stageId);
  if (stageReceipt?.status !== 'verified') throw new ConfigError('CROSS_PLAN_PRODUCER_STAGE_INCOMPLETE', `Producer stage '${evidence.stageId}' is not verified`);
  const deployed = manifest.contracts.find((contract) => contract.logicalId === evidence.logicalId);
  const stageOutput = stageReceipt.outputs?.[evidence.logicalId];
  if (!deployed || !stageOutput || stageOutput.address?.toLowerCase() !== deployed.address.toLowerCase() ||
      stageOutput.transactionHash?.toLowerCase() !== deployed.deploymentTx.toLowerCase() || stageOutput.blockNumber !== deployed.blockNumber ||
      stageOutput.runtimeBytecodeSha256 !== deployed.artifact.runtimeBytecodeSha256) {
    throw new ConfigError('CROSS_PLAN_CONTRACT_SUBSTITUTION', 'Producer stage output does not match the manifest deployment identity');
  }

  const verification = verificationSchema.safeParse(evidence.producerVerification);
  if (!verification.success) throw new ConfigError('CROSS_PLAN_VERIFICATION_INVALID', 'Producer live verification is malformed or incomplete');
  const verificationBody = { ...verification.data } as Record<string, unknown>;
  delete verificationBody.verificationRoot;
  const verificationDomain = verification.data.type === 'protocol-deployment-verification/v2' ? LIVE_VERIFICATION_V2_DOMAIN : LIVE_VERIFICATION_V1_DOMAIN;
  const expectedVerificationRoot = `0x${keccak256Hex(`${verificationDomain}${canonicalJson(verificationBody)}`)}`;
  if (verification.data.verificationRoot !== expectedVerificationRoot || verification.data.manifestRoot !== manifestRoot ||
      verification.data.chain.id !== manifest.chain.id || verification.data.result !== 'passed') {
    throw new ConfigError('CROSS_PLAN_VERIFICATION_MISMATCH', 'Producer live verification does not authenticate the pinned manifest and chain');
  }
  const verifiedContract = verification.data.contracts.find((contract) => contract.logicalId === evidence.logicalId);
  if (!verifiedContract || verifiedContract.address.toLowerCase() !== deployed.address.toLowerCase()) {
    throw new ConfigError('CROSS_PLAN_VERIFICATION_CONTRACT_MISSING', 'Producer live verification does not include the selected deployed contract');
  }
  const verificationRoot = verification.data.verificationRoot;
  if (verificationRoot !== source.producer.verificationRoot) throw new ConfigError('CROSS_PLAN_VERIFICATION_ROOT_MISMATCH', 'Producer live verification root differs from consumer pin');

  const value = {
    logicalId: deployed.logicalId,
    address: deployed.address,
    transactionHash: deployed.deploymentTx,
    blockNumber: deployed.blockNumber,
    blockHash: evidence.deploymentBlockHash,
    runtimeBytecodeSha256: deployed.artifact.runtimeBytecodeSha256,
    artifact: deployed.artifact,
  };
  const outputRoot = stageOutputValueRoot(value);
  if (outputRoot !== source.producer.outputRoot || value.address.toLowerCase() !== source.producer.address.toLowerCase()) {
    throw new ConfigError('CROSS_PLAN_OUTPUT_SUBSTITUTION', 'Consumed output value/address differs from the consumer plan pin');
  }
  return { chainId: manifest.chain.id, producerPlanHash, producerExecutionRoot: executionRoot, producerManifestRoot: manifestRoot,
    producerVerificationRoot: verificationRoot, evidenceRoot, outputRoot, value };
}
