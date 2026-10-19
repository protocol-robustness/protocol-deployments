#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { readSuccessorDeploymentPlan } from '../deployment/successor-plan';
import { assertManifestVerified, computeManifestRoot } from '../deployment/manifest';
import { assertPlanExecutionMatchesManifest } from '../deployment/plan-execution';
import { replayRetainedPrfEvidence } from '../deployment/prf-evidence-replay';
import { verifyLiveDeployment } from '../deployment/live-verification';
import { assertResolvedSpecMatchesManifest, readResolvedVerificationInput, retainedResolvedSpecSha256 } from '../deployment/live-verification-input';
import { BundleConsumer, FixtureBundleLocator } from '../artifacts/bundle';
import { createTransport } from '../runtime/transport';
import { ConfigError } from '../errors';
import type { DeploymentManifest } from '../deployment/manifest';
import { buildPlanVerificationReport, persistPlanVerificationReport } from '../deployment/plan-verification-report';
import { assertCapitalFlowExecutionComplete, replayCapitalFlowEvidence } from '../deployment/capital-flow-replay';
import { replayEffectiveVerifierClosureFromManifest } from '../deployment/verifier-runtime-closure';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function read(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main(): Promise<void> {
  const planFile = arg('plan');
  const manifestFile = arg('manifest');
  const receiptFile = arg('receipt');
  const prfRoot = arg('prf-root');
  const trustedContextRoot = arg('trusted-context-root');
  const rpcUrl = arg('rpc-url');
  const resolvedFile = arg('resolved');
  const fixtures = arg('fixtures');
  const reportFile = arg('out');
  const capitalFlowFile = arg('capital-flow-evidence');
  if (!planFile || !manifestFile || !receiptFile || !prfRoot || !trustedContextRoot || !rpcUrl || !resolvedFile || !fixtures) {
    throw new Error('Usage: verify-plan-execution.ts --plan <plan.json> --manifest <manifest.json> --receipt <plan-execution.json> --prf-root <PRF source root> --trusted-context-root <independently supplied context root> --resolved <resolved spec> --fixtures <pinned fixture root> --rpc-url <URL> [--capital-flow-evidence <capital-flow.json>] [--out <verification-report.json>]');
  }
  const plan = readSuccessorDeploymentPlan(planFile);
  const manifestSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('protocol-deployment-manifest/v1') }).passthrough(),
    z.object({ type: z.literal('protocol-deployment-manifest/v2'), externalContracts: z.array(z.unknown()) }).passthrough(),
  ]);
  const manifest = manifestSchema.parse(read(manifestFile)) as unknown as DeploymentManifest;
  const receipt = z.object({ type: z.literal('protocol-deployment-plan-execution/v1') }).passthrough().parse(read(receiptFile)) as Record<string, unknown>;
  assertManifestVerified(manifest);
  assertPlanExecutionMatchesManifest(receipt, plan, manifest);
  const replayedPrfAssertions = replayRetainedPrfEvidence(manifest, prfRoot, trustedContextRoot, rpcUrl);
  const resolvedInput = readResolvedVerificationInput(resolvedFile);
  if (receipt.resolvedSpecSha256 !== retainedResolvedSpecSha256(resolvedInput)) {
    throw new ConfigError('PLAN_EXECUTION_SPEC_MISMATCH', 'Resolved-spec evidence does not match the digest committed by the plan receipt');
  }
  assertResolvedSpecMatchesManifest(manifest, resolvedInput);
  const resolved = resolvedInput.spec;
  const bundle = new BundleConsumer(new FixtureBundleLocator(path.resolve(fixtures)));
  const transport = createTransport(rpcUrl);
  const verifierClosureAssertions = [];
  for (const closure of plan.verifierClosures) {
    const replayed = await replayEffectiveVerifierClosureFromManifest({
      closure, manifest, contracts: resolved.contracts, bundle, transport, expectedChainId: manifest.chain.id,
    });
    if (!replayed) {
      throw new ConfigError('VERIFIER_RUNTIME_CLOSURE_MISMATCH', `Retained verifier closure '${closure.adapterLogicalId}' does not match the pinned profile and independent RPC observations`);
    }
    verifierClosureAssertions.push(replayed.assertion);
  }
  const live = manifest.type === 'protocol-deployment-manifest/v2'
    ? await verifyLiveDeployment(manifest, transport, resolved, bundle, undefined, verifierClosureAssertions)
    : await verifyLiveDeployment(manifest, transport, resolved, bundle, undefined, verifierClosureAssertions);
  const sealResult = manifest.finalAssertions?.find((assertion) => assertion.id === 'prf-genesis-seal-result' && assertion.status === 'passed');
  let sealedGenesisRoot: string | undefined;
  try { sealedGenesisRoot = sealResult?.detail ? String((JSON.parse(sealResult.detail) as { chainInstanceGenesisRoot?: unknown }).chainInstanceGenesisRoot) : undefined; }
  catch { /* The plan verifier reports malformed seal evidence when applicable. */ }
  const stages = Array.isArray(receipt.stages) ? receipt.stages as Array<Record<string, unknown>> : [];
  const configurationStage = stages.find((stage) => stage.id === 'apply-successor-configuration' && stage.status === 'verified');
  const configurationOutputs = configurationStage?.outputs as Record<string, unknown> | undefined;
  const appliedConfigurationRoot = typeof configurationOutputs?.activeConfigurationRoot === 'string' ? configurationOutputs.activeConfigurationRoot : '';
  const appliedConfigurationEpoch = typeof configurationOutputs?.activeConfigurationEpoch === 'number' ? configurationOutputs.activeConfigurationEpoch : -1;
  const successorDerivationAssertion = manifest.finalAssertions?.find((assertion) => assertion.id === 'prf-successor-configuration-derivation' && assertion.status === 'passed');
  let initialConfigurationRoot = '';
  try {
    const detail = successorDerivationAssertion?.detail ? JSON.parse(successorDerivationAssertion.detail) as Record<string, unknown> : undefined;
    const derivation = detail?.derivation as Record<string, unknown> | undefined;
    const c0 = derivation?.['configuration/C0-root'];
    if (typeof c0 === 'string' && /^sha256:[0-9a-f]{64}$/.test(c0)) initialConfigurationRoot = `0x${c0.slice(7)}`;
  } catch { /* Capital-flow replay fails closed if retained C0 derivation is missing or malformed. */ }
  if (capitalFlowFile) assertCapitalFlowExecutionComplete(receipt.executionStatus);
  if (capitalFlowFile && !/^0x[0-9a-f]{64}$/.test(initialConfigurationRoot)) {
    throw new ConfigError('CAPITAL_FLOW_CONFIGURATION_MISMATCH', 'Capital-flow replay requires the independently retained C0 root from successor derivation evidence');
  }
  const capitalFlow = capitalFlowFile
    ? await replayCapitalFlowEvidence(read(capitalFlowFile), transport, sealedGenesisRoot ?? '', appliedConfigurationRoot, appliedConfigurationEpoch, initialConfigurationRoot, manifest, resolved)
    : { evidenceRoot: null, replayedTransactions: 0, replayedStateAssertions: 0 };
  const report = buildPlanVerificationReport({
    planId: plan.planId,
    executionStatus: String(receipt.executionStatus) as 'complete' | 'partial',
    planExecutionRoot: String(receipt.planExecutionRoot),
    manifestRoot: computeManifestRoot(manifest),
    resolvedSpecSha256: retainedResolvedSpecSha256(resolvedInput),
    replayedPrfAssertions,
    liveVerificationRoot: live.verificationRoot,
    capitalFlowEvidenceRoot: capitalFlow.evidenceRoot,
    replayedCapitalFlowTransactions: capitalFlow.replayedTransactions,
    replayedCapitalFlowStateAssertions: capitalFlow.replayedStateAssertions,
  });
  if (reportFile) {
    persistPlanVerificationReport(report, reportFile);
  }
  console.log(`Plan execution evidence verified`);
  console.log(`  plan: ${plan.planId}`);
  console.log(`  deployments: ${manifest.contracts.length}`);
  console.log(`  manifest root: ${computeManifestRoot(manifest)}`);
  console.log(`  execution root: ${receipt.planExecutionRoot}`);
  console.log(`  execution status: ${receipt.executionStatus}`);
  console.log(`  PRF approval and derivation verifiers replayed: ${replayedPrfAssertions}`);
  console.log(`  live chain verification recomputed: ${live.verificationRoot}`);
  console.log(`  capital-flow transaction actions replayed: ${capitalFlow.replayedTransactions}${capitalFlow.evidenceRoot ? ` (${capitalFlow.evidenceRoot})` : ' (not supplied)'}`);
  console.log(`  capital-flow historical state assertions replayed: ${capitalFlow.replayedStateAssertions}`);
  console.log(`  independent verification report root: ${report.reportRoot}${reportFile ? ` (${reportFile})` : ''}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
