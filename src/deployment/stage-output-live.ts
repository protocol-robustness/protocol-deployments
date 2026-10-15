import { z } from 'zod';
import { canonicalJson } from '../canonical-json';
import { ConfigError } from '../errors';
import type { BundleConsumer } from '../artifacts/bundle';
import { artifactIdentityOf, type ArtifactIdentity } from './record';
import { runtimeMatches } from './engine';
import type { ResolvedContract } from '../canonical';
import type { RpcTransport } from '../runtime/transport';
import type { SuccessorDeploymentPlanV1 } from './successor-plan';

export const stageOutputDeploymentFactV1Schema = z.object({
  logicalId: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: z.string().regex(/^\d+$/),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  runtimeBytecodeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  artifact: z.object({
    source: z.string(), package: z.string(), version: z.string(), artifactName: z.string(),
    abiSha256: z.string(), creationBytecodeSha256: z.string(), runtimeBytecodeSha256: z.string(),
  }).strict(),
}).strict();

export type StageOutputDeploymentFactV1 = z.infer<typeof stageOutputDeploymentFactV1Schema>;

/**
 * Auxiliary stage values have no semantic verifier in plan v1. They may be
 * retained as receipt-committed evidence only while they are not used as an
 * input by another stage or selected as a contract dependency. This prevents
 * an unverified value from becoming deployment authority.
 */
export function mayRetainCommittedAuxiliaryOutput(input: {
  plan: SuccessorDeploymentPlanV1;
  stageId: string;
  outputName: string;
  value: unknown;
}): boolean {
  const stage = input.plan.stages.find((candidate) => candidate.id === input.stageId);
  if (!stage?.produces.includes(input.outputName)) return false;
  if (typeof input.value === 'object' && input.value !== null && 'logicalId' in input.value) return false;
  const consumedByStage = input.plan.stages.some((candidate) =>
    Object.values(candidate.consumes).some((reference) => reference.stage === input.stageId && reference.output === input.outputName));
  const selectedAsContract = Object.values(input.plan.contracts).some((source) =>
    source.kind === 'stage-output' && source.stage === input.stageId && source.output === input.outputName);
  return !consumedByStage && !selectedAsContract;
}

/**
 * Authenticate a contract fact emitted by a declared deployment stage. A
 * selected stage-output dependency additionally requires the exact output
 * name in the plan. Other values are deliberately not promoted by this
 * helper; they need a stage-specific semantic verifier.
 */
export async function verifyStageOutputContractFact(input: {
  plan: SuccessorDeploymentPlanV1;
  stageId: string;
  outputName: string;
  value: unknown;
  contracts: Readonly<Record<string, ResolvedContract>>;
  bundle: BundleConsumer;
  transport: RpcTransport;
  expectedChainId: number;
}): Promise<{ logicalId: string; address: string; selectedStageOutput: boolean } | undefined> {
  const parsed = stageOutputDeploymentFactV1Schema.safeParse(input.value);
  if (!parsed.success) return undefined;
  const fact = parsed.data;
  const source = input.plan.contracts[fact.logicalId];
  const contract = input.contracts[fact.logicalId];
  if (!source || !contract || !('stage' in source) || source.stage !== input.stageId) return undefined;
  const selectedStageOutput = source.kind === 'stage-output';
  if (selectedStageOutput && source.output !== input.outputName) return undefined;
  if (source.kind !== 'deploy' && source.kind !== 'local-fixture' && !selectedStageOutput) return undefined;

  const expectedArtifact = artifactIdentityOf(contract);
  if (!await verifyStageOutputDeploymentFact({
    logicalId: fact.logicalId,
    value: fact,
    contract,
    expectedArtifact,
    bundle: input.bundle,
    transport: input.transport,
    expectedChainId: input.expectedChainId,
  })) return undefined;
  return { logicalId: fact.logicalId, address: fact.address, selectedStageOutput };
}

/** Reauthenticate a stage output against its deployment transaction and pinned artifact. */
export async function verifyStageOutputDeploymentFact(input: {
  logicalId: string;
  value: unknown;
  contract: ResolvedContract;
  expectedArtifact: ArtifactIdentity;
  bundle: BundleConsumer;
  transport: RpcTransport;
  expectedChainId: number;
}): Promise<boolean> {
  const parsed = stageOutputDeploymentFactV1Schema.safeParse(input.value);
  if (!parsed.success || parsed.data.logicalId !== input.logicalId ||
      parsed.data.runtimeBytecodeSha256 !== input.expectedArtifact.runtimeBytecodeSha256 ||
      canonicalJson(parsed.data.artifact) !== canonicalJson(input.expectedArtifact) ||
      canonicalJson(artifactIdentityOf(input.contract)) !== canonicalJson(input.expectedArtifact)) return false;

  const chainId = await input.transport.getChainId();
  if (chainId !== input.expectedChainId) return false;
  const fact = parsed.data;
  const receipt = await input.transport.getTransactionReceipt(fact.transactionHash as `0x${string}`);
  if (!receipt || receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== fact.address.toLowerCase() ||
      receipt.blockNumber.toString() !== fact.blockNumber) return false;
  const block = await input.transport.getBlock(receipt.blockNumber);
  if (block.hash.toLowerCase() !== fact.blockHash.toLowerCase()) return false;

  const artifact = input.bundle.loadArtifact(
    input.contract.artifactSource,
    input.contract.artifact.package,
    input.contract.artifact.version,
    input.contract.artifactName,
  ).artifact;
  const variableRanges = [
    ...Object.values(artifact.deployedLinkReferences ?? {}).flatMap((byName) => Object.values(byName).flat()),
    ...Object.values(artifact.immutableReferences ?? {}).flat(),
  ];
  const historicalCode = await input.transport.getCode(fact.address as `0x${string}`, receipt.blockNumber);
  const currentCode = await input.transport.getCode(fact.address as `0x${string}`);
  return Boolean(historicalCode && currentCode &&
    runtimeMatches(artifact.deployedBytecode, historicalCode, variableRanges) &&
    runtimeMatches(artifact.deployedBytecode, currentCode, variableRanges));
}

/** Throwing wrapper for callers that need a clear authority-boundary failure. */
export async function assertStageOutputDeploymentFact(input: Parameters<typeof verifyStageOutputDeploymentFact>[0]): Promise<void> {
  if (!await verifyStageOutputDeploymentFact(input)) {
    throw new ConfigError('STAGE_OUTPUT_LIVE_VERIFICATION_FAILED', `Stage output for '${input.logicalId}' does not match its observed deployment receipt and current pinned runtime`);
  }
}
