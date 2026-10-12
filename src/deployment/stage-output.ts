import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { canonicalJson } from '../canonical-json';
import { keccak256Hex } from '../artifacts/hash';
import { ConfigError } from '../errors';
import type { SuccessorDeploymentPlanV1 } from './successor-plan';
import { deploymentPlanHash } from './plan-execution';

export const STAGE_OUTPUT_RECEIPT_DOMAIN = 'prf-deployment-stage-output:v1:';
export const STAGE_OUTPUT_VALUE_DOMAIN = 'prf-deployment-stage-value:v1:';
export const STAGE_DEFINITION_DOMAIN = 'prf-deployment-stage-definition:v1:';

const root = z.string().regex(/^0x[0-9a-f]{64}$/);
const inputSchema = z.object({
  stageId: z.string().min(1),
  outputName: z.string().min(1),
  receiptRoot: root,
  outputRoot: root,
}).strict();
const outputSchema = z.object({
  value: z.unknown(),
  outputRoot: root,
}).strict();

export const stageOutputReceiptV1Schema = z.object({
  type: z.literal('protocol-deployment-stage-output/v1'),
  planId: z.string().min(1),
  planHash: root,
  stageId: z.string().min(1),
  stageDefinitionHash: root,
  environment: z.string().min(1),
  chainId: z.number().int().positive(),
  sourceRevision: z.string().min(1),
  artifactIdentities: z.record(z.string().min(1), root),
  inputs: z.record(z.string().min(1), inputSchema),
  outputs: z.record(z.string().min(1), outputSchema),
  observations: z.array(z.unknown()),
  receiptRoot: root,
}).strict();

export type StageOutputReceiptV1 = z.infer<typeof stageOutputReceiptV1Schema>;

const independentlyVerifiedReceipts = new WeakSet<object>();

export interface StageOutputInput {
  stageId: string;
  outputName: string;
  receipt: StageOutputReceiptV1;
}

export interface StageOutputReceiptBodyV1 extends Omit<StageOutputReceiptV1, 'receiptRoot'> {}

export function stageDefinitionHash(stage: SuccessorDeploymentPlanV1['stages'][number]): string {
  return hash(STAGE_DEFINITION_DOMAIN, stage);
}

export function stageOutputValueRoot(value: unknown): string {
  return hash(STAGE_OUTPUT_VALUE_DOMAIN, value);
}

/** Persist a receipt immutably; identical retries reuse the existing evidence. */
export function writeStageOutputReceipt(directory: string, receipt: StageOutputReceiptV1): string {
  const parsed = stageOutputReceiptV1Schema.parse(receipt);
  const file = path.join(directory, `${encodeURIComponent(parsed.stageId)}.${parsed.receiptRoot.slice(2, 14)}.stage-output.v1.json`);
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readStageOutputReceipt(file);
    if (canonicalJson(existing) !== canonicalJson(parsed)) {
      throw new ConfigError('STAGE_OUTPUT_RECEIPT_EXISTS_CONFLICT', `Refusing to overwrite conflicting stage receipt '${file}'`);
    }
  }
  return file;
}

export function readStageOutputReceipt(file: string): StageOutputReceiptV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError('STAGE_OUTPUT_RECEIPT_UNREADABLE', `Cannot read stage output receipt '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = stageOutputReceiptV1Schema.safeParse(raw);
  if (!parsed.success) throw new ConfigError('STAGE_OUTPUT_RECEIPT_INVALID', `Stage output receipt '${file}' failed schema validation`, { details: { issues: parsed.error.issues } });
  return parsed.data;
}

export function createStageOutputReceipt(input: {
  plan: SuccessorDeploymentPlanV1;
  stageId: string;
  environment: string;
  chainId: number;
  sourceRevision: string;
  artifactIdentities: Record<string, string>;
  predecessorInputs: Record<string, StageOutputInput>;
  outputs: Record<string, unknown>;
  observations?: unknown[];
}): StageOutputReceiptV1 {
  const stage = input.plan.stages.find((candidate) => candidate.id === input.stageId);
  if (!stage) throw new ConfigError('STAGE_OUTPUT_UNKNOWN_STAGE', `Unknown stage '${input.stageId}'`);
  const expectedInputNames = Object.keys(stage.consumes).sort();
  if (canonicalJson(Object.keys(input.predecessorInputs).sort()) !== canonicalJson(expectedInputNames)) {
    throw new ConfigError('STAGE_OUTPUT_INPUT_SET', `Stage '${stage.id}' predecessor output set does not match its declared consumes map`);
  }
  if (canonicalJson(Object.keys(input.outputs).sort()) !== canonicalJson([...stage.produces].sort())) {
    throw new ConfigError('STAGE_OUTPUT_OUTPUT_SET', `Stage '${stage.id}' output set does not match its declared produces list`);
  }
  const inputs = Object.fromEntries(Object.entries(input.predecessorInputs).map(([name, item]) => {
    if (item.receipt.planHash !== deploymentPlanHash(input.plan)) {
      throw new ConfigError('STAGE_OUTPUT_PARENT_PLAN', `Input '${name}' belongs to a different plan`);
    }
    const declared = stage.consumes[name];
    if (!declared || declared.stage !== item.stageId || declared.output !== item.outputName) {
      throw new ConfigError('STAGE_OUTPUT_PARENT_BINDING', `Input '${name}' does not match the declared predecessor stage/output`);
    }
    const parent = item.receipt.outputs[item.outputName];
    if (!parent) throw new ConfigError('STAGE_OUTPUT_PARENT_MISSING', `Predecessor output '${item.outputName}' is absent`);
    return [name, {
      stageId: item.stageId,
      outputName: item.outputName,
      receiptRoot: item.receipt.receiptRoot,
      outputRoot: parent.outputRoot,
    }];
  }));
  const body: StageOutputReceiptBodyV1 = {
    type: 'protocol-deployment-stage-output/v1',
    planId: input.plan.planId,
    planHash: deploymentPlanHash(input.plan),
    stageId: stage.id,
    stageDefinitionHash: stageDefinitionHash(stage),
    environment: input.environment,
    chainId: input.chainId,
    sourceRevision: input.sourceRevision,
    artifactIdentities: input.artifactIdentities,
    inputs,
    outputs: Object.fromEntries(Object.entries(input.outputs).map(([name, value]) => [name, { value, outputRoot: stageOutputValueRoot(value) }])),
    observations: input.observations ?? [],
  };
  return stageOutputReceiptV1Schema.parse({ ...body, receiptRoot: hash(STAGE_OUTPUT_RECEIPT_DOMAIN, body) });
}

/**
 * Verify a retained receipt against the selected plan and already verified
 * predecessor receipts. A valid hash is only an integrity check: callers must
 * provide a live/evidence verifier for every output before using it.
 */
export async function verifyStageOutputReceipt(input: {
  receipt: unknown;
  plan: SuccessorDeploymentPlanV1;
  stageId: string;
  environment: string;
  chainId: number;
  sourceRevision: string;
  artifactIdentities: Record<string, string>;
  predecessorReceipts: Readonly<Record<string, StageOutputReceiptV1>>;
  verifyOutput: (outputName: string, value: unknown, observations: unknown[]) => Promise<boolean>;
}): Promise<StageOutputReceiptV1> {
  const parsed = stageOutputReceiptV1Schema.safeParse(input.receipt);
  if (!parsed.success) throw new ConfigError('STAGE_OUTPUT_RECEIPT_INVALID', 'Stage output receipt failed schema validation', { details: { issues: parsed.error.issues } });
  const receipt = parsed.data;
  const stage = input.plan.stages.find((candidate) => candidate.id === input.stageId);
  if (!stage) throw new ConfigError('STAGE_OUTPUT_UNKNOWN_STAGE', `Unknown stage '${input.stageId}'`);
  if (receipt.planId !== input.plan.planId || receipt.planHash !== deploymentPlanHash(input.plan) || receipt.stageId !== stage.id || receipt.stageDefinitionHash !== stageDefinitionHash(stage)) {
    throw new ConfigError('STAGE_OUTPUT_IDENTITY_MISMATCH', `Receipt does not match plan/stage '${stage.id}'`);
  }
  if (receipt.environment !== input.environment || receipt.chainId !== input.chainId) throw new ConfigError('STAGE_OUTPUT_CHAIN_MISMATCH', 'Stage output belongs to a different environment or chain');
  if (receipt.sourceRevision !== input.sourceRevision || canonicalJson(receipt.artifactIdentities) !== canonicalJson(input.artifactIdentities)) {
    throw new ConfigError('STAGE_OUTPUT_PROVENANCE_MISMATCH', 'Stage output source or artifact identities differ from the selected execution');
  }
  const body = { ...receipt } as Record<string, unknown>;
  delete body.receiptRoot;
  if (receipt.receiptRoot !== hash(STAGE_OUTPUT_RECEIPT_DOMAIN, body)) throw new ConfigError('STAGE_OUTPUT_RECEIPT_ROOT_MISMATCH', 'Stage output receipt root is invalid');
  if (canonicalJson(Object.keys(receipt.outputs).sort()) !== canonicalJson([...stage.produces].sort())) throw new ConfigError('STAGE_OUTPUT_OUTPUT_SET', `Receipt output set differs from stage '${stage.id}'`);
  if (canonicalJson(Object.keys(receipt.inputs).sort()) !== canonicalJson(Object.keys(stage.consumes).sort())) throw new ConfigError('STAGE_OUTPUT_INPUT_SET', `Receipt input set differs from stage '${stage.id}'`);
  for (const [name, reference] of Object.entries(stage.consumes)) {
    const parentReceipt = input.predecessorReceipts[reference.stage];
    const recordedInput = receipt.inputs[name];
    const parentOutput = parentReceipt?.outputs[reference.output];
    if (!parentReceipt || !independentlyVerifiedReceipts.has(parentReceipt) || !recordedInput || !parentOutput ||
        parentReceipt.planHash !== receipt.planHash ||
        recordedInput.stageId !== reference.stage || recordedInput.outputName !== reference.output ||
        recordedInput.receiptRoot !== parentReceipt.receiptRoot || recordedInput.outputRoot !== parentOutput.outputRoot) {
      throw new ConfigError('STAGE_OUTPUT_PARENT_MISMATCH', `Receipt input '${name}' is missing, stale or substituted`);
    }
  }
  for (const [name, output] of Object.entries(receipt.outputs)) {
    if (output.outputRoot !== stageOutputValueRoot(output.value)) throw new ConfigError('STAGE_OUTPUT_VALUE_ROOT_MISMATCH', `Output '${name}' value does not match its commitment`);
    if (!await input.verifyOutput(name, output.value, receipt.observations)) throw new ConfigError('STAGE_OUTPUT_LIVE_VERIFICATION_FAILED', `Output '${name}' was not independently verified`);
  }
  independentlyVerifiedReceipts.add(receipt);
  return receipt;
}

/**
 * Verify a set of retained stage receipts in plan order. Partial receipt sets
 * are useful after an interrupted run, but a stage cannot be considered
 * complete unless every declared predecessor is present and verified.
 */
export async function verifyStageOutputReceiptGraph(input: {
  receipts: Readonly<Record<string, unknown>>;
  plan: SuccessorDeploymentPlanV1;
  environment: string;
  chainId: number;
  sourceRevision: string;
  artifactIdentities: Record<string, string>;
  verifyOutput: (stageId: string, outputName: string, value: unknown, observations: unknown[]) => Promise<boolean>;
}): Promise<Record<string, StageOutputReceiptV1>> {
  const knownStages = new Set(input.plan.stages.map((stage) => stage.id));
  for (const stageId of Object.keys(input.receipts)) {
    if (!knownStages.has(stageId)) throw new ConfigError('STAGE_OUTPUT_UNKNOWN_STAGE', `Receipt set contains unknown stage '${stageId}'`);
  }

  const verified: Record<string, StageOutputReceiptV1> = {};
  for (const stage of input.plan.stages) {
    const raw = input.receipts[stage.id];
    if (raw === undefined) continue;
    const missingPrerequisite = stage.dependsOn.find((parent) => verified[parent] === undefined);
    if (missingPrerequisite) {
      throw new ConfigError('STAGE_OUTPUT_PREREQUISITE_UNVERIFIED', `Stage '${stage.id}' cannot be verified before predecessor '${missingPrerequisite}'`);
    }
    const predecessorReceipts = Object.fromEntries(
      [...new Set(Object.values(stage.consumes).map((binding) => binding.stage))]
        .map((parent) => [parent, verified[parent]!]),
    );
    verified[stage.id] = await verifyStageOutputReceipt({
      receipt: raw,
      plan: input.plan,
      stageId: stage.id,
      environment: input.environment,
      chainId: input.chainId,
      sourceRevision: input.sourceRevision,
      artifactIdentities: input.artifactIdentities,
      predecessorReceipts,
      verifyOutput: (name, value, observations) => input.verifyOutput(stage.id, name, value, observations),
    });
  }
  return verified;
}

/** Resolve one declared input from a previously verified stage receipt. */
export function resolveVerifiedStageOutput(input: {
  plan: SuccessorDeploymentPlanV1;
  verifiedReceipts: Readonly<Record<string, StageOutputReceiptV1>>;
  consumerStageId: string;
  inputName: string;
}): { value: unknown; producerStageId: string; outputName: string; receiptRoot: string; outputRoot: string } {
  const consumer = input.plan.stages.find((stage) => stage.id === input.consumerStageId);
  if (!consumer) throw new ConfigError('STAGE_OUTPUT_UNKNOWN_STAGE', `Unknown consumer stage '${input.consumerStageId}'`);
  const binding = consumer.consumes[input.inputName];
  if (!binding) throw new ConfigError('STAGE_OUTPUT_UNDECLARED_INPUT', `Stage '${consumer.id}' does not declare input '${input.inputName}'`);
  const receipt = input.verifiedReceipts[binding.stage];
  if (!receipt || !independentlyVerifiedReceipts.has(receipt) || receipt.stageId !== binding.stage || receipt.planHash !== deploymentPlanHash(input.plan)) {
    throw new ConfigError('STAGE_OUTPUT_PARENT_UNVERIFIED', `Input '${input.inputName}' has no verified receipt from '${binding.stage}'`);
  }
  const output = receipt.outputs[binding.output];
  if (!output) throw new ConfigError('STAGE_OUTPUT_PARENT_MISSING', `Verified stage '${binding.stage}' has no output '${binding.output}'`);
  return {
    value: output.value,
    producerStageId: receipt.stageId,
    outputName: binding.output,
    receiptRoot: receipt.receiptRoot,
    outputRoot: output.outputRoot,
  };
}

function hash(domain: string, value: unknown): string {
  return `0x${keccak256Hex(`${domain}${canonicalJson(value)}`)}`;
}
