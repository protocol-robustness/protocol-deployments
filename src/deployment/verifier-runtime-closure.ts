import { decodeFunctionResult, encodeFunctionData, keccak256, type Abi, type Address } from 'viem';
import type { BundleConsumer } from '../artifacts/bundle';
import type { ResolvedContract } from '../canonical';
import { artifactIdentityOf, type ContractDeploymentFact } from './record';
import { runtimeMatches } from './engine';
import type { RpcTransport } from '../runtime/transport';
import type { StageOutputDeploymentFactV1 } from './stage-output-live';
import { verifyStageOutputDeploymentFact } from './stage-output-live';
import type { SuccessorDeploymentPlanV1 } from './successor-plan';
import type { DeploymentManifest } from './manifest';
import type { LiveAssertionResult } from './live-verification';
import { canonicalJson } from '../canonical-json';

/** Convert a durable deployment record into a receipt-pinned closure fact. */
export async function deploymentFactFromRecord(input: {
  fact: ContractDeploymentFact;
  transport: RpcTransport;
}): Promise<StageOutputDeploymentFactV1 | undefined> {
  const receipt = await input.transport.getTransactionReceipt(input.fact.transactionHash);
  if (!receipt || receipt.status !== 'success' ||
      receipt.contractAddress?.toLowerCase() !== input.fact.address.toLowerCase() ||
      receipt.blockNumber.toString() !== input.fact.blockNumber) return undefined;
  const block = await input.transport.getBlock(receipt.blockNumber);
  return {
    logicalId: input.fact.logicalId,
    address: input.fact.address,
    transactionHash: input.fact.transactionHash,
    blockNumber: input.fact.blockNumber,
    blockHash: block.hash,
    runtimeBytecodeSha256: input.fact.artifact.runtimeBytecodeSha256,
    artifact: input.fact.artifact,
  };
}

export interface EffectiveVerifierClosureEvidence {
  adapter: { logicalId: string; address: string; transactionHash: string; blockNumber: string; blockHash: string; runtimeCodeKeccak256AtDeployment: string; runtimeCodeKeccak256Now: string };
  verifier: { logicalId: string; address: string; transactionHash: string; blockNumber: string; blockHash: string; runtimeCodeKeccak256AtDeployment: string; runtimeCodeKeccak256Now: string };
  effectiveVerifier: { atDeployment: string; now: string };
  metadata: Record<string, { atDeployment: string; now: string }>;
}

/** Prove and retain the adapter's effective verifier and runtime closure. */
export async function inspectEffectiveVerifierClosure(input: {
  closure: SuccessorDeploymentPlanV1['verifierClosures'][number];
  adapterFact: StageOutputDeploymentFactV1;
  verifierFact: StageOutputDeploymentFactV1;
  contracts: Readonly<Record<string, ResolvedContract>>;
  bundle: BundleConsumer;
  transport: RpcTransport;
  expectedChainId: number;
}): Promise<EffectiveVerifierClosureEvidence | undefined> {
  const adapter = input.contracts[input.closure.adapterLogicalId];
  const verifier = input.contracts[input.closure.verifierLogicalId];
  if (!adapter || !verifier || input.adapterFact.logicalId !== input.closure.adapterLogicalId ||
      input.verifierFact.logicalId !== input.closure.verifierLogicalId) return undefined;
  if (!await verifyStageOutputDeploymentFact({ logicalId: input.closure.adapterLogicalId, value: input.adapterFact,
    contract: adapter, expectedArtifact: artifactIdentityOf(adapter), bundle: input.bundle,
    transport: input.transport, expectedChainId: input.expectedChainId }) ||
      !await verifyStageOutputDeploymentFact({ logicalId: input.closure.verifierLogicalId, value: input.verifierFact,
        contract: verifier, expectedArtifact: artifactIdentityOf(verifier), bundle: input.bundle,
        transport: input.transport, expectedChainId: input.expectedChainId })) return undefined;

  const adapterArtifact = input.bundle.loadArtifact(adapter.artifactSource, adapter.artifact.package,
    adapter.artifact.version, adapter.artifactName).artifact;
  const abi = adapterArtifact.abi as Abi;
  const read = async (functionName: string, blockNumber?: bigint): Promise<unknown> => {
    const data = encodeFunctionData({ abi, functionName: functionName as never, args: [] } as never);
    const raw = await input.transport.call({ to: input.adapterFact.address as Address, data }, blockNumber);
    return decodeFunctionResult({ abi, functionName: functionName as never, data: raw } as never);
  };
  const checks: Array<[string, string]> = [
    ['programVKey', input.closure.expectedProgramVKey],
    ['programElfSha256', input.closure.expectedProgramElfSha256],
    ['statementSchemaVersion', input.closure.expectedStatementSchemaVersion],
    ['publicValuesSchema', input.closure.expectedPublicValuesSchema],
  ];
  const receipt = await input.transport.getTransactionReceipt(input.adapterFact.transactionHash as `0x${string}`);
  if (!receipt) return undefined;
  const effectiveAtDeployment = await read('sp1Verifier', receipt.blockNumber);
  const effectiveNow = await read('sp1Verifier');
  if (String(effectiveAtDeployment).toLowerCase() !== input.verifierFact.address.toLowerCase() ||
      String(effectiveNow).toLowerCase() !== input.verifierFact.address.toLowerCase()) return undefined;
  const metadata: EffectiveVerifierClosureEvidence['metadata'] = {};
  for (const [name, expected] of checks) {
    const actualAtDeployment = await read(name, receipt.blockNumber);
    const actualNow = await read(name);
    if (String(actualAtDeployment).toLowerCase() !== expected.toLowerCase() ||
        String(actualNow).toLowerCase() !== expected.toLowerCase()) return undefined;
    metadata[name] = { atDeployment: String(actualAtDeployment), now: String(actualNow) };
  }
  const verifierArtifact = input.bundle.loadArtifact(verifier.artifactSource, verifier.artifact.package,
    verifier.artifact.version, verifier.artifactName).artifact;
  const ranges = [
    ...Object.values(verifierArtifact.deployedLinkReferences ?? {}).flatMap((byName) => Object.values(byName).flat()),
    ...Object.values(verifierArtifact.immutableReferences ?? {}).flat(),
  ];
  const historical = await input.transport.getCode(input.verifierFact.address as Address, receipt.blockNumber);
  const current = await input.transport.getCode(input.verifierFact.address as Address);
  const adapterHistorical = await input.transport.getCode(input.adapterFact.address as Address, receipt.blockNumber);
  const adapterCurrent = await input.transport.getCode(input.adapterFact.address as Address);
  if (!historical || !current || !adapterHistorical || !adapterCurrent ||
      !runtimeMatches(verifierArtifact.deployedBytecode, historical, ranges) ||
      !runtimeMatches(verifierArtifact.deployedBytecode, current, ranges)) return undefined;
  const adapterReceipt = await input.transport.getTransactionReceipt(input.adapterFact.transactionHash as `0x${string}`);
  const adapterBlock = BigInt(input.adapterFact.blockNumber);
  if (!adapterReceipt || adapterReceipt.blockNumber !== adapterBlock) return undefined;
  return {
    adapter: {
      logicalId: input.closure.adapterLogicalId,
      address: input.adapterFact.address,
      transactionHash: input.adapterFact.transactionHash,
      blockNumber: input.adapterFact.blockNumber,
      blockHash: input.adapterFact.blockHash,
      runtimeCodeKeccak256AtDeployment: keccak256(adapterHistorical),
      runtimeCodeKeccak256Now: keccak256(adapterCurrent),
    },
    verifier: {
      logicalId: input.closure.verifierLogicalId,
      address: input.verifierFact.address,
      transactionHash: input.verifierFact.transactionHash,
      blockNumber: input.verifierFact.blockNumber,
      blockHash: input.verifierFact.blockHash,
      runtimeCodeKeccak256AtDeployment: keccak256(historical),
      runtimeCodeKeccak256Now: keccak256(current),
    },
    effectiveVerifier: { atDeployment: String(effectiveAtDeployment), now: String(effectiveNow) },
    metadata,
  };
}

/** Boolean compatibility wrapper for receipt-verification call sites. */
export async function verifyEffectiveVerifierClosure(input: Parameters<typeof inspectEffectiveVerifierClosure>[0]): Promise<boolean> {
  return (await inspectEffectiveVerifierClosure(input)) !== undefined;
}

/** Independently replay a retained closure assertion from a deployment manifest. */
export async function replayEffectiveVerifierClosureFromManifest(input: {
  closure: SuccessorDeploymentPlanV1['verifierClosures'][number];
  manifest: DeploymentManifest;
  contracts: Readonly<Record<string, ResolvedContract>>;
  bundle: BundleConsumer;
  transport: RpcTransport;
  expectedChainId: number;
}): Promise<{ evidence: EffectiveVerifierClosureEvidence; assertion: LiveAssertionResult } | undefined> {
  const assertionId = `verifier-runtime-closure:${input.closure.adapterLogicalId}`;
  const retained = input.manifest.finalAssertions.find((assertion) => assertion.id === assertionId && assertion.status === 'passed');
  if (!retained?.detail) return undefined;
  let retainedEvidence: unknown;
  try { retainedEvidence = JSON.parse(retained.detail); } catch { return undefined; }
  const adapterRecord = input.manifest.contracts.find((contract) => contract.logicalId === input.closure.adapterLogicalId);
  const verifierRecord = input.manifest.contracts.find((contract) => contract.logicalId === input.closure.verifierLogicalId);
  const adapterContract = input.contracts[input.closure.adapterLogicalId];
  const verifierContract = input.contracts[input.closure.verifierLogicalId];
  if (!adapterRecord || !verifierRecord || !adapterContract || !verifierContract) return undefined;

  const fact = async (record: typeof adapterRecord): Promise<StageOutputDeploymentFactV1 | undefined> => {
    const receipt = await input.transport.getTransactionReceipt(record.deploymentTx);
    if (!receipt || receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== record.address.toLowerCase() ||
        receipt.blockNumber.toString() !== record.blockNumber) return undefined;
    const block = await input.transport.getBlock(receipt.blockNumber);
    return {
      logicalId: record.logicalId,
      address: record.address,
      transactionHash: record.deploymentTx,
      blockNumber: record.blockNumber,
      blockHash: block.hash,
      runtimeBytecodeSha256: record.artifact.runtimeBytecodeSha256,
      artifact: record.artifact,
    };
  };
  const [adapterFact, verifierFact] = await Promise.all([fact(adapterRecord), fact(verifierRecord)]);
  if (!adapterFact || !verifierFact) return undefined;
  const evidence = await inspectEffectiveVerifierClosure({
    closure: input.closure,
    adapterFact,
    verifierFact,
    contracts: input.contracts,
    bundle: input.bundle,
    transport: input.transport,
    expectedChainId: input.expectedChainId,
  });
  if (!evidence || canonicalJson(evidence) !== canonicalJson(retainedEvidence)) return undefined;
  const expected = canonicalJson({
    adapter: { logicalId: input.closure.adapterLogicalId, address: adapterRecord.address, runtimeBytecodeSha256: adapterRecord.artifact.runtimeBytecodeSha256 },
    verifier: { logicalId: input.closure.verifierLogicalId, address: verifierRecord.address, runtimeBytecodeSha256: verifierRecord.artifact.runtimeBytecodeSha256 },
    effectiveVerifier: verifierRecord.address,
    metadata: {
      programVKey: input.closure.expectedProgramVKey,
      programElfSha256: input.closure.expectedProgramElfSha256,
      statementSchemaVersion: input.closure.expectedStatementSchemaVersion,
      publicValuesSchema: input.closure.expectedPublicValuesSchema,
    },
  });
  return {
    evidence,
    assertion: { id: assertionId, target: adapterRecord.address, function: 'effectiveVerifierRuntimeClosure', expected, observed: canonicalJson(evidence), result: 'passed' },
  };
}
