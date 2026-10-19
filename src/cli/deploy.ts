#!/usr/bin/env ts-node
/**
 * Deploy a resolved environment to its configured runtime.
 *
 *   deploy.ts <environment>
 *
 * Flow: resolve spec → bind runtime (transport+signer) → assert chain id →
 * execute the explicit deployment order → write the immutable deployment
 * record (deployments/<env>.deployment.json).
 *
 * The frozen resolved spec (deployments/<env>.resolved.json) is never mutated;
 * observed results are recorded separately.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { randomUUID } from 'crypto';
import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Abi, type Address, type Hex } from 'viem';
import { resolveDeployment } from '../resolve-deployment';
import { loadConfig, loadEnvironment, loadRuntime } from '../config/load';
import { loadDefaultEnvFile } from '../config/env-file';
import { createBundleConsumer, type BundleConsumer } from '../artifacts/bundle';
import { bindRuntime } from '../runtime/bind';
import type { TxFees } from '../runtime/transport';
import { deployContract, verifyRecordedDeployment, type DeployContractResult } from '../deployment/engine';
import { emptyRecord, loadRecord, saveRecord, recordPathFor, artifactIdentityOf, type DeploymentRecord, type FinalAssertionRecord } from '../deployment/record';
import { materializeExecutionSpec } from '../deployment/execution-spec';
import { computeManifestRoot, registryBindingCandidate, type DeploymentManifest, type DeploymentManifestV2 } from '../deployment/manifest';
import { verifyExternalContracts } from '../deployment/external-contracts';
import { executeBootstrapAction, assertBootstrap } from '../deployment/bootstrap';
import { preflightDeployment, assertSufficientBalance } from '../deployment/preflight';
import { assertChainIdMatches } from '../validate/checks';
import { ConfigError } from '../errors';
import type { ResolvedBinding } from '../canonical';
import { deploymentPlanHash, planExecutionRoot } from '../deployment/plan-execution';
import { bindStatementAdmissionSnapshot, executableDeploymentPrefix } from '../deployment/successor-plan';
import { verifyStageOutputReceiptGraph } from '../deployment/stage-output';
import { mayRetainCommittedAuxiliaryOutput, verifyStageOutputContractFact } from '../deployment/stage-output-live';
import { assertSourceRevisionMatchesCheckout } from '../deployment/source-revision';
import { verifyCrossPlanStageOutput } from '../deployment/cross-plan-stage-output';
import { stageOutputDeploymentFactV1Schema } from '../deployment/stage-output-live';
import { deploymentFactFromRecord, inspectEffectiveVerifierClosure, verifyEffectiveVerifierClosure } from '../deployment/verifier-runtime-closure';
import { derivePrfVerifierRegistryRoot } from '../deployment/prf-verifier-registry-derivation';
import { derivePrfSuccessorConfiguration } from '../deployment/prf-successor-configuration';
import { verifyPrfSuccessorTransitionApproval, type PrfSuccessorApprovalInput } from '../deployment/prf-successor-approval';
import { verifyPrfInitialInputApproval, type PrfInitialApprovalEvidence } from '../deployment/prf-initial-approval';
import { genesisRuntimeCodeHashFromPreflight, verifyPrfGenesisSealPreflight, verifyPrfGenesisSealResult, type PrfGenesisSealPreflightEvidence } from '../deployment/prf-genesis-seal-preflight';
import { verifyPrfAuthorityTransition, type PrfAuthorityTransitionEvidence } from '../deployment/prf-authority-transition';
import { retainedResolvedSpecEvidence, retainedResolvedSpecSha256 } from '../deployment/live-verification-input';

interface DeployOptions {
  bundle: BundleConsumer;
  deploymentsDir: string;
  resume: boolean;
  dryRun: boolean;
  assumeYes: boolean;
  fees?: TxFees;
  receiptTimeoutMs?: number;
  plan?: NonNullable<Awaited<ReturnType<typeof resolveDeployment>>['deploymentPlan']>;
  initialApprovalEvidence?: PrfInitialApprovalEvidence;
  genesisSealPreflight?: { prfRoot: string; requestPath: string; trustedContextPath: string };
  successorTransitionApproval?: PrfSuccessorApprovalInput;
  authorityTransitionRequest?: { prfRoot: string; requestPath: string; trustedContextPath: string };
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function bootstrapBindingAvailable(binding: ResolvedBinding, addresses: Record<string, `0x${string}`>): boolean {
  if (binding.kind === 'contract-address' || binding.kind === 'runtime-code-hash') return Boolean(addresses[binding.contract]);
  if (binding.kind === 'array') return binding.values.every((value) => bootstrapBindingAvailable(value, addresses));
  return true;
}

/** Record an assertion exactly once so a resumed run cannot duplicate ids. */
function recordFinalAssertion(record: DeploymentRecord, entry: FinalAssertionRecord): void {
  const existing = record.finalAssertions.findIndex((assertion) => assertion.id === entry.id);
  if (existing >= 0) record.finalAssertions[existing] = entry;
  else record.finalAssertions.push(entry);
}

function sha256RefToBytes32(value: string): Hex {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new ConfigError('PRF_CANONICAL_ROOT_INVALID', 'Expected a canonical lowercase SHA-256 root reference');
  return `0x${value.slice('sha256:'.length)}`;
}

async function verifyPlanStageOutputDependencies(input: {
  plan: NonNullable<DeployOptions['plan']>;
  receipts: NonNullable<Awaited<ReturnType<typeof resolveDeployment>>['stageOutputReceipts']>;
  resolved: Awaited<ReturnType<typeof resolveDeployment>>;
  bundle: BundleConsumer;
  transport: Awaited<ReturnType<typeof bindRuntime>>['transport'];
  sourceRevision: string;
  chainId: number;
}): Promise<Array<{ logicalId: string; stage: string; output: string; receiptRoot: string; outputRoot: string; address: string }>> {
  const artifactIdentities: Record<string, string> = {};
  for (const contract of Object.values(input.resolved.spec.contracts)) {
    const key = `${contract.artifactSource}/${contract.artifact.package}@${contract.artifact.version}`;
    if (!artifactIdentities[key]) {
      const manifest = input.bundle.loadManifest(contract.artifactSource, contract.artifact.package, contract.artifact.version);
      artifactIdentities[key] = `0x${manifest.bundleRoot.replace(/^0x/, '')}`;
    }
  }
  const observed: Array<{ logicalId: string; stage: string; output: string; address: string }> = [];
  const verifiedClosures = new Set<string>();
  const verified = await verifyStageOutputReceiptGraph({
    receipts: input.receipts,
    plan: input.plan,
    environment: input.resolved.spec.environment,
    chainId: input.chainId,
    sourceRevision: input.sourceRevision,
    artifactIdentities,
    verifyOutput: async (stageId, outputName, value) => {
      const authenticated = await verifyStageOutputContractFact({
        plan: input.plan,
        stageId,
        outputName,
        value,
        contracts: input.resolved.spec.contracts,
        bundle: input.bundle,
        transport: input.transport,
        expectedChainId: input.chainId,
      });
      if (authenticated?.selectedStageOutput) {
        observed.push({ logicalId: authenticated.logicalId, stage: stageId, output: outputName, address: authenticated.address });
      }
      for (const closure of input.plan.verifierClosures) {
        if (closure.adapterStage !== stageId || !authenticated || authenticated.logicalId !== closure.adapterLogicalId) continue;
        const verifierStage = input.receipts[closure.verifierStage];
        const verifierOutputName = Object.entries(input.plan.stages.find((stage) => stage.id === closure.verifierStage)?.contractOutputs ?? {})
          .find(([, logicalId]) => logicalId === closure.verifierLogicalId)?.[0];
        const adapterFact = stageOutputDeploymentFactV1Schema.safeParse(value);
        const verifierFact = verifierOutputName ? stageOutputDeploymentFactV1Schema.safeParse(verifierStage?.outputs[verifierOutputName]?.value) : undefined;
        if (!adapterFact.success || !verifierFact?.success || !await verifyEffectiveVerifierClosure({
          closure, adapterFact: adapterFact.data, verifierFact: verifierFact.data,
          contracts: input.resolved.spec.contracts, bundle: input.bundle,
          transport: input.transport, expectedChainId: input.chainId,
        })) return false;
        verifiedClosures.add(closure.adapterLogicalId);
      }
      if (authenticated) return true;
      // The receipt verifier independently checks the output and receipt
      // commitments. Unrecognized non-contract outputs are retained only if
      // the selected plan does not consume them as authority anywhere.
      return mayRetainCommittedAuxiliaryOutput({ plan: input.plan, stageId, outputName, value });
    },
  });
  const selectedClosures = input.plan.verifierClosures.filter((closure) => input.plan.contracts[closure.adapterLogicalId]?.kind === 'stage-output');
  if (selectedClosures.some((closure) => !verifiedClosures.has(closure.adapterLogicalId))) {
    throw new ConfigError('VERIFIER_RUNTIME_CLOSURE_FAILED', 'A plan-required verifier implementation closure was not authenticated from its deployment-stage outputs');
  }
  return observed.map((binding) => {
    const receipt = verified[binding.stage]!;
    const output = receipt.outputs[binding.output]!;
    return { ...binding, receiptRoot: receipt.receiptRoot, outputRoot: output.outputRoot };
  }).sort((a, b) => a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0);
}

async function main(): Promise<void> {
  loadDefaultEnvFile();
  const environment = process.argv[2];
  const profileArg = process.argv.indexOf('--profile');
  const deploymentKeyArg = process.argv.indexOf('--deployment-key');
  const resume = process.argv.includes('--resume');
  const dryRun = process.argv.includes('--dry-run');
  const assumeYes = process.argv.includes('--yes');
  const maxFeeArg = flagValue('max-fee');
  const priorityFeeArg = flagValue('priority-fee');
  const timeoutArg = flagValue('receipt-timeout-ms');
  const planArg = flagValue('plan');
  const stageOutputReceiptsDirArg = flagValue('stage-output-receipts');
  const crossPlanStageOutputEvidenceDirArg = flagValue('cross-plan-stage-output-evidence');
  const genesisSealRequestArg = flagValue('genesis-seal-request');
  const genesisSealTrustedContextArg = flagValue('genesis-seal-trusted-context');
  const successorTransitionManifestArg = flagValue('successor-transition-manifest');
  const successorVerifierRegistryArg = flagValue('successor-verifier-registry');
  const successorTransitionTrustedContextArg = flagValue('successor-transition-trusted-context');
  const successorTransitionApprovalArg = flagValue('successor-transition-approval');
  const authorityTransitionRequestArg = flagValue('authority-transition-request');
  const authorityTransitionTrustedContextArg = flagValue('authority-transition-trusted-context');
  const legacyFlat = process.argv.includes('--legacy-flat');
  const profileDir = profileArg >= 0 ? path.resolve(process.cwd(), process.argv[profileArg + 1]!) : undefined;
  if (!environment || (planArg !== undefined) === legacyFlat) {
    console.error('Usage: deploy.ts <environment> (--plan <plan.json> | --legacy-flat) [--profile <dir>] [--fixtures <dir>] [--stage-output-receipts <dir>] [--cross-plan-stage-output-evidence <dir>] [--source-revision <id>] [--prf-root <dir> --initial-input-manifest <file> --candidate-package-set <file> --initial-input-approval <file> --prf-trusted-context <file> --genesis-seal-request <file> --genesis-seal-trusted-context <file>] [--successor-transition-manifest <file> --successor-verifier-registry <file> --successor-transition-trusted-context <file> --successor-transition-approval <file> --authority-transition-request <file> --authority-transition-trusted-context <file>] [--deployment-key <key>] [--resume] [--dry-run] [--yes] [--max-fee <wei>] [--priority-fee <wei>] [--receipt-timeout-ms <ms>]');
    process.exit(2);
  }
  if (priorityFeeArg !== undefined && maxFeeArg === undefined) {
    console.error('--priority-fee requires --max-fee');
    process.exit(2);
  }
  const fees: TxFees | undefined = maxFeeArg === undefined
    ? undefined
    : { maxFeePerGas: BigInt(maxFeeArg), maxPriorityFeePerGas: BigInt(priorityFeeArg ?? '0') };
  const receiptTimeoutMs = timeoutArg === undefined ? undefined : Number(timeoutArg);
  if (receiptTimeoutMs !== undefined && (!Number.isInteger(receiptTimeoutMs) || receiptTimeoutMs <= 0)) {
    console.error('--receipt-timeout-ms must be a positive integer');
    process.exit(2);
  }
  const configDir = path.resolve(process.cwd(), 'config');
  const fixtureRoot = path.resolve(process.cwd(), flagValue('fixtures') ?? 'fixtures/packages');
  const deploymentsDir = path.resolve(process.cwd(), 'deployments');

  // Source selection must match what is deployed: local runs read fixtures,
  // non-local runs require pinned packages with clean-git provenance.
  const config = loadConfig({ configDir, profileDir });
  const environmentConfig = loadEnvironment(configDir, environment, profileDir);
  const preferFixtures = environmentConfig.chain.kind === undefined || environmentConfig.chain.kind === 'local';
  const requirePinnedProvenance = !preferFixtures;
  const bundle = createBundleConsumer({
    sources: config.architecture.artifactSources,
    fixtureRoot,
    preferFixtures,
    requirePinnedProvenance,
  });

  let initialApprovalEvidence: PrfInitialApprovalEvidence | undefined;
  if (planArg && !dryRun) {
    const required = {
      prfRoot: flagValue('prf-root'),
      manifestPath: flagValue('initial-input-manifest'),
      packageSetPath: flagValue('candidate-package-set'),
      approvalPath: flagValue('initial-input-approval'),
      trustedContextPath: flagValue('prf-trusted-context'),
    };
    if (Object.values(required).some((value) => !value)) {
      throw new ConfigError('PRF_INITIAL_APPROVAL_REQUIRED', 'A bounded plan requires a source-bound initial-input manifest, package set, detached approval and separate trusted context before canonical roots can be resolved');
    }
    initialApprovalEvidence = verifyPrfInitialInputApproval(required as { prfRoot: string; manifestPath: string; packageSetPath: string; approvalPath: string; trustedContextPath: string });
  }
  const resolved = resolveDeployment({
    configDir,
    environment,
    fixtureRoot,
    profileDir,
    preferFixtures,
    requirePinnedProvenance,
    deploymentPlanFile: planArg ? path.resolve(process.cwd(), planArg) : undefined,
    stageOutputReceiptsDir: stageOutputReceiptsDirArg ? path.resolve(process.cwd(), stageOutputReceiptsDirArg) : undefined,
    crossPlanStageOutputEvidenceDir: crossPlanStageOutputEvidenceDirArg ? path.resolve(process.cwd(), crossPlanStageOutputEvidenceDirArg) : undefined,
    approvedRootBindings: initialApprovalEvidence?.approvedRootBindings,
  });
  const requiresGenesisSealGate = resolved.deploymentPlan?.planId === 'prf/controlled-shortfall-successor-fork.v1' &&
    (resolved.spec.deployment.bootstrapActions ?? []).some((action) => action.function === 'sealGenesis');
  const genesisSealPreflight = requiresGenesisSealGate && !dryRun
    ? (() => {
      if (!flagValue('prf-root') || !genesisSealRequestArg || !genesisSealTrustedContextArg) {
        throw new ConfigError('PRF_GENESIS_SEAL_PREFLIGHT_REQUIRED', 'A sealGenesis bootstrap action requires --prf-root, --genesis-seal-request and --genesis-seal-trusted-context');
      }
      return { prfRoot: path.resolve(process.cwd(), flagValue('prf-root')!), requestPath: genesisSealRequestArg, trustedContextPath: genesisSealTrustedContextArg };
    })()
    : undefined;
  const successorApprovalArgs = [successorTransitionManifestArg, successorVerifierRegistryArg,
    successorTransitionTrustedContextArg, successorTransitionApprovalArg];
  const successorTransitionApproval = successorApprovalArgs.some(Boolean)
    ? (() => {
      if (successorApprovalArgs.some((value) => !value) || !flagValue('prf-root')) {
        throw new ConfigError('PRF_SUCCESSOR_APPROVAL_INPUT_INVALID', 'Successor transition approval requires all four review inputs and --prf-root');
      }
      return { prfRoot: path.resolve(process.cwd(), flagValue('prf-root')!),
        manifestPath: successorTransitionManifestArg!, verifierRegistryPath: successorVerifierRegistryArg!,
        trustedContextPath: successorTransitionTrustedContextArg!, approvalPath: successorTransitionApprovalArg! };
    })()
    : undefined;
  const authorityTransitionArgs = [authorityTransitionRequestArg, authorityTransitionTrustedContextArg];
  const authorityTransitionRequest = authorityTransitionArgs.some(Boolean)
    ? (() => {
      if (authorityTransitionArgs.some((value) => !value) || !flagValue('prf-root')) {
        throw new ConfigError('PRF_AUTHORITY_TRANSITION_INPUT_INVALID', 'Authority transition execution requires both --authority-transition-request and --authority-transition-trusted-context, with --prf-root');
      }
      return { prfRoot: path.resolve(process.cwd(), flagValue('prf-root')!),
        requestPath: authorityTransitionRequestArg!, trustedContextPath: authorityTransitionTrustedContextArg! };
    })()
    : undefined;
  if (successorTransitionApproval && !authorityTransitionRequest) {
    throw new ConfigError('PRF_AUTHORITY_TRANSITION_INPUT_REQUIRED', 'Successor transition approval cannot authorize registry or configuration changes without a PRF-verified signed authority-state transition request');
  }
  if (authorityTransitionRequest && !successorTransitionApproval) {
    throw new ConfigError('PRF_SUCCESSOR_APPROVAL_REQUIRED', 'A signed authority-state transition request is accepted only with its separate authenticated C0 -> C1 transition approval');
  }
  // Default the record/manifest key to the *resolved* environment so the ledger
  // always lands next to the `<environment>.resolved.json` that resolve.ts wrote,
  // even when a profile overlay declares a different environment name.
  const deploymentKey = deploymentKeyArg >= 0 ? process.argv[deploymentKeyArg + 1] : resolved.spec.environment;
  const runtime = loadRuntime(configDir, environment);
  const bound = await bindRuntime(runtime, environment, configDir);

  if (!deploymentKey) {
    console.error('Usage: deploy.ts <environment> [--profile <dir>] [--fixtures <dir>] [--deployment-key <key>] [--resume]');
    process.exit(2);
  }

  const options: DeployOptions = { bundle, deploymentsDir, resume, dryRun, assumeYes, fees, receiptTimeoutMs, plan: resolved.deploymentPlan, initialApprovalEvidence, genesisSealPreflight, successorTransitionApproval, authorityTransitionRequest };
  try {
    await run(environment, resolved, bound, deploymentKey, options);
  } finally {
    // Only tear down a devnet this process spawned; a devnet started with
    // `npm run devnet:start` is deliberately left running for follow-up
    // `verify:live` runs against the same chain.
    if (bound.anvil?.ownedByProcess) await bound.anvil.stop().catch(() => {});
  }
}

/** Require explicit confirmation before mutating a non-local chain. */
async function confirmNonLocal(deploymentKey: string, kind: string | undefined): Promise<void> {
  if (kind === 'local' || kind === undefined) return;
  if (process.argv.includes('--yes')) return;
  if (!process.stdin.isTTY) {
    console.error(`Refusing to deploy '${deploymentKey}' (${kind}) without --yes in a non-interactive shell.`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`Deploy '${deploymentKey}' to a ${kind} chain? [y/N] `, resolve));
  rl.close();
  const normalized = answer.trim().toLowerCase();
  if (normalized !== 'y' && normalized !== 'yes') {
    console.error('Aborted.');
    process.exit(1);
  }
}

async function run(
  environment: string,
  resolved: Awaited<ReturnType<typeof resolveDeployment>>,
  bound: Awaited<ReturnType<typeof bindRuntime>>,
  deploymentKey: string,
  options: DeployOptions,
): Promise<void> {
  const { bundle, deploymentsDir, resume, dryRun, fees, receiptTimeoutMs, plan, initialApprovalEvidence, genesisSealPreflight, successorTransitionApproval, authorityTransitionRequest } = options;
  const chainId = await bound.transport.getChainId();
  assertChainIdMatches({ chainId: resolved.spec.chain.chainId, environment }, chainId);
  const deployer = await bound.signer.getAddress();
  const stageOutputSources = Object.entries(plan?.contracts ?? {}).filter(([, source]) => source.kind === 'stage-output');
  let stageOutputBindings: Array<{ logicalId: string; stage: string; output: string; receiptRoot?: string; evidenceRoot?: string; outputRoot: string; address: string }> = [];
  if (stageOutputSources.length > 0) {
    if (!plan) throw new ConfigError('PLAN_STAGE_OUTPUT_RECEIPTS_REQUIRED', 'Selected stage-output dependencies require a plan');
    const legacy = stageOutputSources.some(([, source]) => source.kind === 'stage-output' && !source.producer);
    if (legacy) {
      if (!resolved.stageOutputReceipts) throw new ConfigError('PLAN_STAGE_OUTPUT_RECEIPTS_REQUIRED', 'Legacy stage-output dependencies require --stage-output-receipts');
      const sourceRevision = flagValue('source-revision');
      if (!sourceRevision) throw new ConfigError('PLAN_STAGE_OUTPUT_SOURCE_REVISION_REQUIRED', 'Legacy stage-output dependencies require --source-revision matching the producing execution');
      assertSourceRevisionMatchesCheckout(sourceRevision);
      stageOutputBindings.push(...await verifyPlanStageOutputDependencies({
        plan, receipts: resolved.stageOutputReceipts, resolved, bundle, transport: bound.transport, sourceRevision, chainId,
      }));
    }
    for (const [logicalId, source] of stageOutputSources) {
      if (source.kind !== 'stage-output' || !source.producer) continue;
      const evidence = resolved.crossPlanStageOutputEvidence?.[logicalId];
      if (!evidence) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_REQUIRED', `Cross-plan producer evidence is missing for '${logicalId}'`);
      const authenticated = verifyCrossPlanStageOutput({ consumerPlan: plan, logicalId, evidence, expectedChainId: chainId });
      const contractOutput = await verifyStageOutputContractFact({
        plan, stageId: source.stage, outputName: source.output, value: authenticated.value,
        contracts: resolved.spec.contracts, bundle, transport: bound.transport, expectedChainId: chainId,
      });
      if (!contractOutput?.selectedStageOutput || contractOutput.address.toLowerCase() !== source.producer.address.toLowerCase()) {
        throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_LIVE_VERIFICATION_FAILED', `Producer contract '${logicalId}' failed live receipt/runtime verification`);
      }
      stageOutputBindings.push({ logicalId, stage: source.stage, output: source.output, evidenceRoot: authenticated.evidenceRoot,
        outputRoot: authenticated.outputRoot, address: authenticated.value.address });
    }
    stageOutputBindings.sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  }
  const externalContractObservations = await verifyExternalContracts(resolved.spec, bundle, bound.transport, deployer);
  for (const dependency of externalContractObservations) {
    console.log(`  verified external dependency ${dependency.logicalId} at ${dependency.address} (code ${dependency.observedRuntimeCodeKeccak256})`);
  }

  const preflight = await preflightDeployment({
    transport: bound.transport,
    deployer,
    deploymentSteps: resolved.spec.deployment.steps.length,
    bootstrapActions: (resolved.spec.deployment.bootstrapActions ?? []).length,
    fees,
  });
  console.log(`\nPreflight: ${deploymentKey} (chain ${preflight.chainId})`);
  console.log(`  deployer:  ${deployer}`);
  console.log(`  balance:   ${preflight.balance} wei`);
  console.log(`  fees:      max ${preflight.fees.maxFeePerGas} / priority ${preflight.fees.maxPriorityFeePerGas} wei`);
  console.log(`  est. need: ~${preflight.requiredBalance} wei (worst-case gas ${preflight.gasBudget})`);

  if (dryRun) {
    console.log(`\n--dry-run: ${resolved.spec.deployment.steps.length} deployment(s) and ${(resolved.spec.deployment.bootstrapActions ?? []).length} bootstrap action(s) not sent.`);
    return;
  }
  assertSufficientBalance(preflight);
  await confirmNonLocal(deploymentKey, resolved.spec.chain.kind);

  const recordPath = recordPathFor(deploymentsDir, deploymentKey);
  const existing = resume ? loadRecord(recordPath) : null;
  if (existing && (existing.specHash !== resolved.specHash || existing.deployer !== deployer)) {
    throw new ConfigError('RESUME_MISMATCH', 'Cannot resume deployment: existing record does not match the resolved spec or deployer');
  }
  const planPrefix = plan ? executableDeploymentPrefix(plan, { authorityTransitionInput: Boolean(successorTransitionApproval && authorityTransitionRequest) }) : undefined;
  if (plan && (!initialApprovalEvidence || !planPrefix || planPrefix.contractIds.size === 0)) {
    throw new ConfigError('PLAN_EXECUTABLE_PREFIX_UNAVAILABLE', 'Bounded deployment has no authenticated, executable deployment prefix');
  }
  const record: DeploymentRecord = existing ?? emptyRecord({
    specHash: resolved.specHash,
    environment: deploymentKey,
    chainId: resolved.spec.chain.chainId,
  });
  record.deploymentId ??= randomUUID();
  record.deployer = deployer;
  record.externalContracts = externalContractObservations;
  const externalAddresses = Object.fromEntries(Object.entries(resolved.spec.externalAddresses ?? {})) as Record<string, `0x${string}`>;
  let { executionSpecHash } = materializeExecutionSpec(resolved.spec, resolved.specHash, deployer, externalAddresses);
  record.executionSpecHash = executionSpecHash;
  if (initialApprovalEvidence) {
    recordFinalAssertion(record, {
      id: 'prf-initial-input-approval',
      status: 'passed',
      verifiedAt: new Date().toISOString(),
      detail: JSON.stringify(initialApprovalEvidence),
    });
  }
  // Persist before the first transaction; every subsequent engine transition is durable.
  saveRecord(recordPath, record);

  const results: DeployContractResult[] = [];
  const resolvedAddresses: Record<string, `0x${string}`> = Object.fromEntries(
    Object.entries(resolved.spec.externalContracts ?? {}).map(([logicalId, dependency]) => [logicalId, dependency.address as `0x${string}`]),
  );
  const executedBootstrapActions = new Set<string>(record.bootstrapActions.filter((action) => action.status === 'verified').map((action) => action.id));
  const selectedDeploymentSteps = resolved.spec.deployment.steps.filter((step) => !planPrefix || planPrefix.contractIds.has(step.logicalId));
  const c1StageIndex = plan?.stages.findIndex((stage) => stage.id === 'apply-successor-configuration') ?? -1;
  const stageOrder = new Map(plan?.stages.map((stage, index) => [stage.id, index]) ?? []);
  const preC1DeploymentSteps = selectedDeploymentSteps.filter((step) => {
    if (!plan || c1StageIndex < 0) return true;
    const source = plan.contracts[step.logicalId];
    return !source || !('stage' in source) || (stageOrder.get(source.stage) ?? Number.MAX_SAFE_INTEGER) <= c1StageIndex;
  });
  const postC1DeploymentSteps = selectedDeploymentSteps.filter((step) => !preC1DeploymentSteps.includes(step));
  const deferredConfigurationExecutor = !!planPrefix?.contractIds.has('prf/configuration-executor');
  const deploymentStepsBeforeConfigurationExecutor = preC1DeploymentSteps.filter((step) =>
    !deferredConfigurationExecutor || step.logicalId !== 'prf/configuration-executor');
  const deployStep = async (step: typeof selectedDeploymentSteps[number]): Promise<void> => {
    const prior = record.contracts[step.logicalId];
    if (resume && prior && record.execution[step.logicalId]?.status === 'verified') {
      await verifyRecordedDeployment({
        logicalId: step.logicalId,
        address: prior.address,
        transactionHash: prior.transactionHash,
        blockNumber: prior.blockNumber,
        spec: resolved.spec,
        bundle,
        transport: bound.transport,
      });
      resolvedAddresses[step.logicalId] = prior.address;
      results.push({ logicalId: step.logicalId, artifactName: prior.artifact.artifactName, address: prior.address, transactionHash: prior.transactionHash, blockNumber: BigInt(prior.blockNumber), mode: prior.mode, deployedParameters: prior.deployedParameters });
      console.log(`  ↻ ${step.logicalId} already verified at ${prior.address}`);
    } else {
      const res = await deployContract({
        spec: resolved.spec,
        logicalId: step.logicalId,
        bundle,
        transport: bound.transport,
        signer: bound.signer,
        resolvedAddresses,
        externalAddresses,
        fees,
        receiptTimeoutMs,
        onTransition: async (transition) => {
          record.execution[step.logicalId] = {
            status: transition.status,
            transactionHash: transition.transactionHash,
            blockNumber: transition.blockNumber?.toString(),
            address: transition.address,
          };
          saveRecord(recordPath, record);
        },
      });
      results.push(res);
      resolvedAddresses[step.logicalId] = res.address;
      const contract = resolved.spec.contracts[step.logicalId]!;
      record.contracts[step.logicalId] = {
        kind: 'deployment',
        logicalId: step.logicalId,
        artifact: artifactIdentityOf(contract),
        address: res.address,
        transactionHash: res.transactionHash,
        blockNumber: res.blockNumber.toString(),
        mode: res.mode,
        deployedParameters: res.deployedParameters,
      };
      console.log(`  ✔ ${step.logicalId} -> ${res.address}`);
    }
  };
  for (const step of deploymentStepsBeforeConfigurationExecutor) {
    await deployStep(step);

    // Bootstrap actions run as soon as their target is *available*, whether it
    // was deployed in this run or resumed from a verified record. This permits
    // deployment graphs whose next constructor requires the target's initialized
    // state (for example, sealing genesis before constructing the configuration
    // executor), and it means a resumed run still completes pending bootstrap.
    for (const action of (resolved.spec.deployment.bootstrapActions ?? []).filter((candidate) =>
      !executedBootstrapActions.has(candidate.id) &&
      resolvedAddresses[candidate.target] && candidate.args.every((arg) => bootstrapBindingAvailable(arg, resolvedAddresses)))) {
      // Reuse any existing entry for this id: a retry must replace a failed
      // attempt rather than append a duplicate the manifest gate would reject.
      const existingIndex = record.bootstrapActions.findIndex((candidate) => candidate.id === action.id);
      if (existingIndex >= 0) record.bootstrapActions[existingIndex] = { id: action.id, status: 'planned' };
      else record.bootstrapActions.push({ id: action.id, status: 'planned' });
      const actionIndex = existingIndex >= 0 ? existingIndex : record.bootstrapActions.length - 1;
      saveRecord(recordPath, record);
      try {
        let sealPreflightEvidence: PrfGenesisSealPreflightEvidence | undefined;
        let transitionEnableEvidence: Record<string, unknown> | undefined;
        const verifyTransitionEnableBindings = async (enabled: boolean): Promise<void> => {
          if (!initialApprovalEvidence) throw new ConfigError('PRF_INITIAL_APPROVAL_REQUIRED', 'Authority transition enablement requires authenticated policy-v3 input approval');
          const approved = initialApprovalEvidence.approvedRootBindings;
          const approvedValidator = approved.authorityTransitionValidatorAddress;
          const validatorAddress = resolvedAddresses['prf/authority-transition-validator'];
          const genesisAddress = resolvedAddresses['prf/genesis'];
          const authorityAddress = resolvedAddresses['prf/governance-authority'];
          const validatorContract = resolved.spec.contracts['prf/authority-transition-validator'];
          const genesisContract = resolved.spec.contracts['prf/genesis'];
          const authorityContract = resolved.spec.contracts['prf/governance-authority'];
          const validatorFact = record.contracts['prf/authority-transition-validator'];
          if (!approvedValidator || !validatorAddress || !genesisAddress || !authorityAddress || !validatorContract || !genesisContract || !authorityContract || !validatorFact) {
            throw new ConfigError('PRF_AUTHORITY_TRANSITION_BINDING_REQUIRED', 'Policy-v3 enablement requires approved signer identity and verified validator, genesis and adapter deployments');
          }
          const deployerAddress = await bound.signer.getAddress();
          await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'governor', args: [], expected: deployerAddress,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'protocolGenesisRoot', args: [], expected: approved.protocolGenesisRoot,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'authorityStateRoot', args: [], expected: approved.authorityStateRoot,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: genesisContract, address: genesisAddress, function: 'isSealedState', args: [], expected: false,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: genesisContract, address: genesisAddress, function: 'initialAuthorityStateRoot', args: [], expected: approved.authorityStateRoot,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: genesisContract, address: genesisAddress, function: 'authorityAdapter', args: [], expected: { kind: 'contract-address', contract: 'prf/governance-authority' },
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: validatorContract, address: validatorAddress, function: 'localAuthorityPolicyRoot', args: [], expected: approved.localAuthorityPolicyRoot,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: validatorContract, address: validatorAddress, function: 'transitionValidatorAddress', args: [], expected: approvedValidator,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'authorityTransitionsEnabled', args: [], expected: enabled,
            addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          if (enabled) {
            await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'localAuthorityPolicyRoot', args: [], expected: approved.localAuthorityPolicyRoot,
              addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
            await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'authorityTransitionValidator', args: [], expected: { kind: 'contract-address', contract: 'prf/authority-transition-validator' },
              addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
          }
        };
        const result = await executeBootstrapAction({
          ...action,
          contract: resolved.spec.contracts[action.target]!,
          address: resolvedAddresses[action.target]!,
          addresses: resolvedAddresses,
          externalAddresses,
          transport: bound.transport,
          signer: bound.signer,
          fees,
          receiptTimeoutMs,
          beforeSubmit: action.function === 'enableAuthorityTransitions' ? async (call) => {
            const approved = initialApprovalEvidence?.approvedRootBindings;
            const validatorAddress = resolvedAddresses['prf/authority-transition-validator'];
            if (!approved || !approved.authorityTransitionValidatorAddress || !validatorAddress ||
                call.target.toLowerCase() !== resolvedAddresses['prf/governance-authority']?.toLowerCase() ||
                call.args.length !== 3 || String(call.args[0]).toLowerCase() !== resolvedAddresses['prf/genesis']?.toLowerCase() ||
                String(call.args[1]).toLowerCase() !== approved.localAuthorityPolicyRoot.toLowerCase() ||
                String(call.args[2]).toLowerCase() !== validatorAddress.toLowerCase()) {
              throw new ConfigError('PRF_AUTHORITY_TRANSITION_BINDING_MISMATCH', 'Transition enablement arguments must bind the approved policy root, this genesis and the deployed validator');
            }
            await verifyTransitionEnableBindings(false);
            transitionEnableEvidence = {
              schema: 'prf-authority-transition-enable-preflight.v1',
              manifestRoot: initialApprovalEvidence.manifestRoot,
              localAuthorityPolicyRoot: approved.localAuthorityPolicyRoot,
              transitionValidatorAddress: approved.authorityTransitionValidatorAddress,
              deployedValidatorAddress: validatorAddress,
              genesisAddress: resolvedAddresses['prf/genesis'],
              initialAuthorityStateRoot: approved.authorityStateRoot,
              enabledBefore: false,
            };
            return { evidence: transitionEnableEvidence };
          } : action.function === 'sealGenesis' && genesisSealPreflight ? (call) => {
            if (!genesisSealPreflight || !initialApprovalEvidence) {
              throw new ConfigError('PRF_GENESIS_SEAL_PREFLIGHT_REQUIRED', 'sealGenesis cannot be signed without authenticated initial-input approval and live canonical preflight');
            }
            const authorityBinding = action.args[2];
            if (!authorityBinding || authorityBinding.kind !== 'runtime-code-hash' || !resolvedAddresses[authorityBinding.contract]) {
              throw new ConfigError('PRF_GENESIS_SEAL_ADAPTER_BINDING_REQUIRED', 'sealGenesis arguments do not identify the authority adapter runtime-code binding');
            }
            if (call.args[0] !== `0x${'0'.repeat(64)}`) {
              throw new ConfigError('PRF_GENESIS_SEAL_ROOT_OVERRIDE_FORBIDDEN', 'sealGenesis configuration must use the all-zero root sentinel; arbitrary configured roots cannot be signed');
            }
            sealPreflightEvidence = verifyPrfGenesisSealPreflight({
              ...genesisSealPreflight,
              rpcUrl: bound.transport.rpcUrl,
              genesisAddress: call.target,
              authorityAdapterAddress: resolvedAddresses[authorityBinding.contract]!,
              expectedCall: { from: call.from, target: call.target, function: call.function, args: [undefined, ...call.args.slice(1)] },
              expectedManifestRoot: initialApprovalEvidence.manifestRoot,
            });
            recordFinalAssertion(record, {
              id: 'prf-genesis-seal-preflight', status: 'passed', verifiedAt: new Date().toISOString(),
              detail: JSON.stringify(sealPreflightEvidence),
            });
            saveRecord(recordPath, record);
            return { args: [sealPreflightEvidence.derivedArguments[0], ...call.args.slice(1)], evidence: sealPreflightEvidence };
          } : undefined,
          onTransition: async (transition) => {
            record.bootstrapActions[actionIndex] = {
              ...record.bootstrapActions[actionIndex],
              id: action.id,
              status: transition.status,
              transactionHash: transition.transactionHash,
              blockNumber: transition.blockNumber?.toString(),
            };
            saveRecord(recordPath, record);
          },
        });
        if (action.function === 'enableAuthorityTransitions') {
          if (!transitionEnableEvidence) throw new ConfigError('PRF_AUTHORITY_TRANSITION_PREFLIGHT_REQUIRED', 'Transition enablement completed without retained approval and binding evidence');
          await verifyTransitionEnableBindings(true);
          const enabledEvidence = { ...transitionEnableEvidence, enabledAfter: true, transactionHash: result.transactionHash, blockNumber: result.blockNumber.toString() };
          recordFinalAssertion(record, {
            id: 'prf-authority-transition-enablement', status: 'passed', verifiedAt: new Date().toISOString(), detail: JSON.stringify(enabledEvidence),
          });
          saveRecord(recordPath, record);
        }
        if (action.function === 'sealGenesis' && genesisSealPreflight) {
          if (!sealPreflightEvidence || !genesisSealPreflight || !initialApprovalEvidence) {
            throw new ConfigError('PRF_GENESIS_SEAL_PREFLIGHT_REQUIRED', 'Seal transaction completed without retained preflight evidence');
          }
          const authorityBinding = action.args[2];
          if (!authorityBinding || authorityBinding.kind !== 'runtime-code-hash' || !resolvedAddresses[authorityBinding.contract]) {
            throw new ConfigError('PRF_GENESIS_SEAL_ADAPTER_BINDING_REQUIRED', 'sealGenesis arguments do not identify the authority adapter runtime-code binding');
          }
          const sealResult = verifyPrfGenesisSealResult({
            ...genesisSealPreflight,
            rpcUrl: bound.transport.rpcUrl,
            genesisAddress: resolvedAddresses[action.target]!,
            authorityAdapterAddress: resolvedAddresses[authorityBinding.contract]!,
            transactionHash: result.transactionHash,
            expectedManifestRoot: initialApprovalEvidence.manifestRoot,
            expectedGenesisRoot: sealPreflightEvidence.computedRoot,
            preflightOutput: sealPreflightEvidence.output,
          });
          recordFinalAssertion(record, {
            id: 'prf-genesis-seal-result', status: 'passed', verifiedAt: new Date().toISOString(),
            detail: JSON.stringify(sealResult),
          });
          saveRecord(recordPath, record);
        }
        record.bootstrapActions[actionIndex] = {
          ...record.bootstrapActions[actionIndex],
          id: action.id, status: 'verified', transactionHash: result.transactionHash, blockNumber: result.blockNumber.toString(), verification: 'receipt-success',
        };
        executedBootstrapActions.add(action.id);
        saveRecord(recordPath, record);
      } catch (error) {
        record.bootstrapActions[actionIndex] = {
          ...record.bootstrapActions[actionIndex],
          id: action.id, status: 'failed', verification: error instanceof Error ? error.message : String(error),
        };
        saveRecord(recordPath, record);
        throw error;
      }
    }
  }
  const partialPlanExecution = !!plan && (
    selectedDeploymentSteps.length < resolved.spec.deployment.steps.length ||
    plan.stages.some((stage) => !planPrefix?.stageIds.has(stage.id))
  );
  if (partialPlanExecution) {
    record.status = 'partial';
    recordFinalAssertion(record, {
      id: 'plan-execution-prefix',
      status: 'passed',
      verifiedAt: new Date().toISOString(),
      detail: JSON.stringify({ executionStatus: 'partial', blockedStages: planPrefix?.blockedStageIds ?? [] }),
    });
    saveRecord(recordPath, record);
    console.log(`\n⏸ Executed verified plan prefix (${selectedDeploymentSteps.length}/${resolved.spec.deployment.steps.length} deployments). Remaining stages require an evidence-producing executor: ${planPrefix?.blockedStageIds.join(', ')}`);
  }
  const verifierClosureEvidenceByAdapter = new Map<string, NonNullable<Awaited<ReturnType<typeof inspectEffectiveVerifierClosure>>>>();
  for (const closure of plan?.verifierClosures ?? []) {
    const adapterSource = plan!.contracts[closure.adapterLogicalId];
    const verifierSource = plan!.contracts[closure.verifierLogicalId];
    if (adapterSource?.kind === 'stage-output') continue; // independently checked with its signed stage receipt above
    if (!adapterSource || (adapterSource.kind !== 'deploy' && adapterSource.kind !== 'local-fixture') ||
        !verifierSource || (verifierSource.kind !== 'deploy' && verifierSource.kind !== 'local-fixture')) {
      throw new ConfigError('VERIFIER_RUNTIME_CLOSURE_FAILED', `Verifier closure '${closure.adapterLogicalId}' does not have a verifiable deployment source for both adapter and implementation`);
    }
    const adapterDeployment = record.contracts[closure.adapterLogicalId];
    const verifierDeployment = record.contracts[closure.verifierLogicalId];
    if (!adapterDeployment || !verifierDeployment ||
        record.execution[closure.adapterLogicalId]?.status !== 'verified' ||
        record.execution[closure.verifierLogicalId]?.status !== 'verified') {
      throw new ConfigError('VERIFIER_RUNTIME_CLOSURE_FAILED', `Verifier closure '${closure.adapterLogicalId}' is missing verified deployment facts`);
    }
    const adapterFact = await deploymentFactFromRecord({ fact: adapterDeployment, transport: bound.transport });
    const verifierFact = await deploymentFactFromRecord({ fact: verifierDeployment, transport: bound.transport });
    const closureEvidence = adapterFact && verifierFact ? await inspectEffectiveVerifierClosure({
      closure, adapterFact, verifierFact,
      contracts: resolved.spec.contracts, bundle, transport: bound.transport, expectedChainId: chainId,
    }) : undefined;
    if (!closureEvidence) {
      recordFinalAssertion(record, { id: `verifier-runtime-closure:${closure.adapterLogicalId}`, status: 'failed', verifiedAt: new Date().toISOString(), detail: 'fresh verifier runtime closure failed' });
      saveRecord(recordPath, record);
      throw new ConfigError('VERIFIER_RUNTIME_CLOSURE_FAILED', `Verifier closure '${closure.adapterLogicalId}' failed after fresh deployment`);
    }
    verifierClosureEvidenceByAdapter.set(closure.adapterLogicalId, closureEvidence);
    recordFinalAssertion(record, {
      id: `verifier-runtime-closure:${closure.adapterLogicalId}`,
      status: 'passed',
      verifiedAt: new Date().toISOString(),
      detail: JSON.stringify(closureEvidence),
    });
    saveRecord(recordPath, record);
  }
  if (planPrefix?.stageIds.has('derive-registry-roots')) {
    const closure = plan?.verifierClosures.find((candidate) => candidate.adapterLogicalId === 'prf/source-bound-entitlement-verifier-adapter-v1');
    const closureEvidence = closure && verifierClosureEvidenceByAdapter.get(closure.adapterLogicalId);
    const registryDeployment = record.contracts['prf/verifier-registry'];
    const registryContract = resolved.spec.contracts['prf/verifier-registry'];
    if (!closure || !closureEvidence || !registryDeployment || !registryContract || !genesisSealPreflight?.prfRoot) {
      throw new ConfigError('PRF_VERIFIER_REGISTRY_DERIVATION_INPUT_MISSING', 'Verified adapter closure, deployed registry, and PRF root are required to derive the successor registry');
    }
    await verifyRecordedDeployment({
      logicalId: 'prf/verifier-registry', address: registryDeployment.address,
      transactionHash: registryDeployment.transactionHash, blockNumber: registryDeployment.blockNumber,
      spec: resolved.spec, bundle, transport: bound.transport,
    });
    const block = await bound.transport.getBlock();
    const entry = {
      id: keccak256(toBytes(closure.expectedProgramId)),
      adapter: closureEvidence.adapter.address,
      programVKey: closure.expectedProgramVKey,
      programElfSha256: closure.expectedProgramElfSha256,
      programId: closure.expectedProgramId,
      statementSchemaVersionHash: closure.expectedStatementSchemaVersion,
      publicValuesSchema: closure.expectedPublicValuesSchema,
      active: true,
    };
    const registryArtifact = bundle.loadArtifact(registryContract.artifactSource, registryContract.artifact.package,
      registryContract.artifact.version, registryContract.artifactName).artifact;
    const registryAbi = registryArtifact.abi as Abi;
    const rootCall = encodeFunctionData({
      abi: registryAbi,
      functionName: 'computeCanonicalRoot',
      args: [[entry.id], [entry.adapter as Address], [entry.programVKey], [entry.programElfSha256], [entry.programId],
        [entry.statementSchemaVersionHash], [entry.publicValuesSchema], [entry.active]],
    } as never);
    const solidityRoot = decodeFunctionResult({
      abi: registryAbi, functionName: 'computeCanonicalRoot',
      data: await bound.transport.call({ to: registryDeployment.address as Address, data: rootCall }, block.number),
    } as never) as Hex;
    const registryEvidence = derivePrfVerifierRegistryRoot({
      prfRoot: genesisSealPreflight.prfRoot, entry, observationBlock: block, solidityRoot,
    });
    recordFinalAssertion(record, {
      id: 'prf-successor-registry-derivation', status: 'passed', verifiedAt: new Date().toISOString(),
      detail: JSON.stringify(registryEvidence),
    });
    saveRecord(recordPath, record);
  }
  if (planPrefix?.stageIds.has('derive-genesis-roots') && plan?.stages.some((stage) => stage.id === 'seal-empty-verifier-registry')) {
    if (!plan || !initialApprovalEvidence) {
      throw new ConfigError('PRF_INITIAL_APPROVAL_REQUIRED', 'The empty verifier registry can only be sealed under authenticated initial-input approval');
    }
    const action = plan.authorizedConfigurationActions.find((candidate) => candidate.id === 'seal-empty-verifier-registry');
    const registryAddress = resolvedAddresses['prf/verifier-registry'];
    const authorityAddress = resolvedAddresses['prf/governance-authority'];
    const registryContract = resolved.spec.contracts['prf/verifier-registry'];
    const authorityContract = resolved.spec.contracts['prf/governance-authority'];
    const registryFact = record.contracts['prf/verifier-registry'];
    const registryRoot = initialApprovalEvidence.approvedRootBindings.initialVerifierRegistryRoot as Hex;
    const genesisSealResult = record.finalAssertions.find((candidate) => candidate.id === 'prf-genesis-seal-result' && candidate.status === 'passed');
    if (!action || action.target !== 'prf/verifier-registry' || action.function !== 'sealRegistry' || !registryAddress || !authorityAddress || !registryContract || !authorityContract || !registryFact) {
      throw new ConfigError('PRF_EMPTY_REGISTRY_ACTION_INVALID', 'The plan lacks the declared empty-registry seal action or its verified deployment facts');
    }
    if (!genesisSealResult) throw new ConfigError('PRF_EMPTY_REGISTRY_GENESIS_NOT_SEALED', 'The empty registry cannot be sealed until the chain-instance genesis result is verified');
    const existingSeal = record.bootstrapActions.find((candidate) => candidate.id === 'prf/seal-empty-verifier-registry' && candidate.status === 'verified');
    if (!existingSeal) {
      const governor = await bound.signer.getAddress();
      await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'governor', args: [], expected: governor, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
      await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'governor', args: [], expected: governor, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
      const registryArtifact = bundle.loadArtifact(registryContract.artifactSource, registryContract.artifact.package,
        registryContract.artifact.version, registryContract.artifactName).artifact;
      const registryAbi = registryArtifact.abi as Abi;
      const block = await bound.transport.getBlock();
      const emptyRootCall = encodeFunctionData({ abi: registryAbi, functionName: 'computeCanonicalRoot',
        args: [[], [], [], [], [], [], [], []], } as never);
      const computedEmptyRoot = decodeFunctionResult({ abi: registryAbi, functionName: 'computeCanonicalRoot',
        data: await bound.transport.call({ to: registryAddress, data: emptyRootCall }, block.number), } as never) as Hex;
      if (computedEmptyRoot.toLowerCase() !== registryRoot.toLowerCase()) {
        throw new ConfigError('PRF_EMPTY_REGISTRY_ROOT_MISMATCH', 'Solidity empty-registry root differs from the root in authenticated PRF initial approval', {
          details: { approved: registryRoot, solidity: computedEmptyRoot, blockNumber: block.number.toString(), blockHash: block.hash },
        });
      }
      await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'verifierCount', args: [{ kind: 'literal', value: registryRoot }], expected: 0, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
      await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'isSealed', args: [{ kind: 'literal', value: registryRoot }], expected: false, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
      const entry = record.bootstrapActions.findIndex((candidate) => candidate.id === 'prf/seal-empty-verifier-registry');
      const actionIndex = entry >= 0 ? entry : record.bootstrapActions.push({ id: 'prf/seal-empty-verifier-registry', status: 'planned' }) - 1;
      saveRecord(recordPath, record);
      const sealed = await executeBootstrapAction({
        contract: registryContract, address: registryAddress, function: action.function,
        args: [{ kind: 'literal', value: registryRoot }], addresses: resolvedAddresses, externalAddresses,
        transport: bound.transport, signer: bound.signer, fees, receiptTimeoutMs,
        beforeSubmit: async (call) => {
          if (call.from.toLowerCase() !== governor.toLowerCase() || call.args[0] !== registryRoot) {
            throw new ConfigError('PRF_EMPTY_REGISTRY_SEAL_CALL_MISMATCH', 'Empty-registry seal call differs from the verified governor and approved root');
          }
        },
        onTransition: async (transition) => {
          record.bootstrapActions[actionIndex] = { id: 'prf/seal-empty-verifier-registry', status: transition.status,
            transactionHash: transition.transactionHash, blockNumber: transition.blockNumber?.toString() };
          saveRecord(recordPath, record);
        },
      });
      await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'isSealed', args: [{ kind: 'literal', value: registryRoot }], expected: true, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
      record.bootstrapActions[actionIndex] = { id: 'prf/seal-empty-verifier-registry', status: 'verified', transactionHash: sealed.transactionHash,
        blockNumber: sealed.blockNumber.toString(), verification: 'receipt-success-and-sealed-readback' };
      recordFinalAssertion(record, { id: 'prf-empty-registry-seal-result', status: 'passed', verifiedAt: new Date().toISOString(),
        detail: JSON.stringify({ schema: 'prf-empty-registry-seal-result.v1', root: registryRoot, computedEmptyRoot,
          transactionHash: sealed.transactionHash, blockNumber: sealed.blockNumber.toString(), blockNumberAtDerivation: block.number.toString(), blockHashAtDerivation: block.hash,
          governor, authorityGovernor: governor, registryArtifactRuntimeBytecodeSha256: registryFact.artifact.runtimeBytecodeSha256 }) });
      saveRecord(recordPath, record);
    }
    const confirmedSeal = record.bootstrapActions.find((candidate) => candidate.id === 'prf/seal-empty-verifier-registry' && candidate.status === 'verified');
    if (!confirmedSeal) throw new ConfigError('PRF_EMPTY_REGISTRY_SEAL_RECEIPT_MISSING', 'Empty-registry state has no successful retained sealing receipt');
    const governor = await bound.signer.getAddress();
    await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'governor', args: [], expected: governor, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'governor', args: [], expected: governor, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'verifierCount', args: [{ kind: 'literal', value: registryRoot }], expected: 0, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'isSealed', args: [{ kind: 'literal', value: registryRoot }], expected: true, addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
  }
  if (deferredConfigurationExecutor) {
    const step = selectedDeploymentSteps.find((candidate) => candidate.logicalId === 'prf/configuration-executor');
    if (!step) throw new ConfigError('PLAN_EXECUTABLE_PREFIX_UNAVAILABLE', 'Configuration-executor stage is selected without a deployment step');
    const prior = record.contracts[step.logicalId];
    if (resume && prior && record.execution[step.logicalId]?.status === 'verified') {
      await verifyRecordedDeployment({ logicalId: step.logicalId, address: prior.address, transactionHash: prior.transactionHash,
        blockNumber: prior.blockNumber, spec: resolved.spec, bundle, transport: bound.transport });
      resolvedAddresses[step.logicalId] = prior.address;
      results.push({ logicalId: step.logicalId, artifactName: prior.artifact.artifactName, address: prior.address,
        transactionHash: prior.transactionHash, blockNumber: BigInt(prior.blockNumber), mode: prior.mode, deployedParameters: prior.deployedParameters });
      console.log(`  ↻ ${step.logicalId} already verified at ${prior.address}`);
    } else {
      const deployed = await deployContract({ spec: resolved.spec, logicalId: step.logicalId, bundle, transport: bound.transport,
        signer: bound.signer, resolvedAddresses, externalAddresses, fees, receiptTimeoutMs,
        onTransition: async (transition) => {
          record.execution[step.logicalId] = { status: transition.status, transactionHash: transition.transactionHash,
            blockNumber: transition.blockNumber?.toString(), address: transition.address };
          saveRecord(recordPath, record);
        },
      });
      results.push(deployed);
      resolvedAddresses[step.logicalId] = deployed.address;
      const contract = resolved.spec.contracts[step.logicalId]!;
      record.contracts[step.logicalId] = { kind: 'deployment', logicalId: step.logicalId, artifact: artifactIdentityOf(contract),
        address: deployed.address, transactionHash: deployed.transactionHash, blockNumber: deployed.blockNumber.toString(),
        mode: deployed.mode, deployedParameters: deployed.deployedParameters };
      console.log(`  ✔ ${step.logicalId} -> ${deployed.address}`);
    }
  }
  if (planPrefix?.stageIds.has('derive-successor-configuration')) {
    if (!plan || !initialApprovalEvidence || !genesisSealPreflight) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_INPUT_MISSING', 'Successor derivation requires authenticated C0, sealed genesis preflight and a derived successor registry');
    }
    const sealAssertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-genesis-seal-preflight' && candidate.status === 'passed');
    const registryAssertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-registry-derivation' && candidate.status === 'passed');
    if (!sealAssertion?.detail || !registryAssertion?.detail) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_INPUT_MISSING', 'Retained genesis and successor-registry derivations are required before deriving C1');
    }
    const sealEvidence = JSON.parse(sealAssertion.detail) as { output?: string; computedRoot?: string };
    const registryEvidence = JSON.parse(registryAssertion.detail) as { root?: string };
    if (!sealEvidence.output || !sealEvidence.computedRoot || !registryEvidence.root) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_INPUT_MISSING', 'Retained PRF outputs do not expose the sealed instance artifact and successor registry root');
    }
    const sealOutput = JSON.parse(sealEvidence.output) as { artifact?: Record<string, unknown> };
    const approvalOutput = JSON.parse(initialApprovalEvidence.output) as { 'initial-configuration'?: Record<string, unknown> };
    const artifact = sealOutput.artifact;
    const initialConfiguration = approvalOutput['initial-configuration'];
    if (!artifact || !initialConfiguration) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_INPUT_MISSING', 'Approved C0 or independently derived chain-instance artifact is missing');
    }
    const derived = derivePrfSuccessorConfiguration({
      prfRoot: genesisSealPreflight.prfRoot,
      initialConfiguration,
      protocolGenesisRoot: `sha256:${initialApprovalEvidence.approvedRootBindings.protocolGenesisRoot.slice(2)}`,
      chainInstanceGenesis: artifact,
      expectedChainInstanceGenesisRoot: sealEvidence.computedRoot,
      expectedInitialConfigurationRoot: `sha256:${initialApprovalEvidence.approvedRootBindings.initialConfigurationRoot.slice(2)}`,
      successorVerifierRegistryRoot: `sha256:${registryEvidence.root.slice(2)}`,
      successorProofMode: plan.successorProofMode,
      epoch: 1,
    });
    recordFinalAssertion(record, { id: 'prf-successor-configuration-derivation', status: 'passed', verifiedAt: new Date().toISOString(), detail: JSON.stringify(derived) });
    if (successorTransitionApproval) {
      const derivation = derived.derivation;
      const transition = derivation['configuration-transition'] as Record<string, unknown>;
      const approvalEvidence = verifyPrfSuccessorTransitionApproval(successorTransitionApproval, {
        'protocol/genesis-root': String(derivation['protocol-genesis-root']),
        'execution/chain-id': chainId,
        'chain-instance-genesis-root': String(derivation['chain-instance-genesis-root']),
        'configuration/parent-root': String(derivation['configuration/C0-root']),
        'configuration/new-root': String(derivation['configuration/C1-root']),
        epoch: Number(transition.epoch),
        'entitlement-proof-mode': plan.successorProofMode,
        qualification: 'local-only',
      });
      recordFinalAssertion(record, { id: 'prf-successor-transition-approval', status: 'passed', verifiedAt: new Date().toISOString(), detail: JSON.stringify(approvalEvidence) });
      if (!authorityTransitionRequest) throw new ConfigError('PRF_AUTHORITY_TRANSITION_INPUT_REQUIRED', 'An approved C0 -> C1 transition also requires the signed authority-state transition request');
      const authorityEvidence = verifyPrfAuthorityTransition(authorityTransitionRequest, {
        'chain-instance-genesis-root': String(derivation['chain-instance-genesis-root']),
        'adapter-address': resolvedAddresses['prf/governance-authority']!,
        'previous-root': `sha256:${initialApprovalEvidence.approvedRootBindings.authorityStateRoot.slice(2)}`,
        'policy-root': `sha256:${initialApprovalEvidence.approvedRootBindings.localAuthorityPolicyRoot.slice(2)}`,
        'decision-root': String(derivation['decision-root']),
        'transition-root': String(derivation['decision-root']),
        'previous-revision': 0,
        'successor-revision': 1,
      });
      recordFinalAssertion(record, { id: 'prf-authority-transition-verification', status: 'passed', verifiedAt: new Date().toISOString(), detail: JSON.stringify(authorityEvidence) });
    }
    saveRecord(recordPath, record);
  }
  if ((planPrefix?.stageIds.has('register-successor-verifier') || planPrefix?.stageIds.has('seal-successor-verifier-registry')) && successorTransitionApproval) {
    const approval = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-transition-approval' && candidate.status === 'passed');
    const registryDerivation = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-registry-derivation' && candidate.status === 'passed');
    const registryAddress = resolvedAddresses['prf/verifier-registry'];
    const authorityAddress = resolvedAddresses['prf/governance-authority'];
    const registryContract = resolved.spec.contracts['prf/verifier-registry'];
    const authorityContract = resolved.spec.contracts['prf/governance-authority'];
    const registerAction = plan?.authorizedConfigurationActions.find((candidate) => candidate.id === 'register-successor-verifier');
    const sealAction = plan?.authorizedConfigurationActions.find((candidate) => candidate.id === 'seal-successor-verifier-registry');
    if (!approval?.detail || !registryDerivation?.detail || !registryAddress || !authorityAddress || !registryContract || !authorityContract ||
        registerAction?.target !== 'prf/verifier-registry' || registerAction.function !== 'registerVerifier' ||
        sealAction?.target !== 'prf/verifier-registry' || sealAction.function !== 'sealRegistry') {
      throw new ConfigError('PRF_SUCCESSOR_REGISTRY_APPROVAL_REQUIRED', 'Successor registry mutations require verified transition approval, derived registry evidence, and plan-declared actions');
    }
    const approvalEvidence = JSON.parse(approval.detail) as { manifestRoot?: string; scope?: Record<string, unknown> };
    const derivedRegistry = JSON.parse(registryDerivation.detail) as { root?: Hex; entry?: Record<string, unknown>; solidityRoot?: Hex };
    const successorConfig = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-configuration-derivation' && candidate.status === 'passed');
    const derivedConfiguration = successorConfig?.detail ? JSON.parse(successorConfig.detail) as { derivation?: Record<string, unknown> } : undefined;
    const derivedTransition = derivedConfiguration?.derivation?.['configuration-transition'] as Record<string, unknown> | undefined;
    if (!approvalEvidence.manifestRoot || !approvalEvidence.scope || !derivedRegistry.root || !derivedRegistry.entry ||
        !derivedTransition || approvalEvidence.scope['configuration/new-root'] !== derivedTransition['configuration/C1-root'] ||
        approvalEvidence.scope['configuration/parent-root'] !== derivedTransition['configuration/C0-root']) {
      throw new ConfigError('PRF_SUCCESSOR_REGISTRY_APPROVAL_SCOPE_MISMATCH', 'Transition approval does not bind the retained C0-to-C1 derivation and successor registry');
    }
    const entry = derivedRegistry.entry as { id: Hex; adapter: Address; programVKey: Hex; programElfSha256: Hex; programId: string;
      statementSchemaVersionHash: Hex; publicValuesSchema: Hex; active: boolean };
    const registryRoot = derivedRegistry.root;
    const governor = await bound.signer.getAddress();
    await assertBootstrap({ contract: registryContract, address: registryAddress, function: 'governor', args: [], expected: governor,
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'governor', args: [], expected: governor,
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    const registryArtifact = bundle.loadArtifact(registryContract.artifactSource, registryContract.artifact.package,
      registryContract.artifact.version, registryContract.artifactName).artifact;
    const registryAbi = registryArtifact.abi as Abi;
    const rootCall = encodeFunctionData({ abi: registryAbi, functionName: 'computeCanonicalRoot',
      args: [[entry.id], [entry.adapter], [entry.programVKey], [entry.programElfSha256], [entry.programId],
        [entry.statementSchemaVersionHash], [entry.publicValuesSchema], [entry.active]], } as never);
    const liveDerivedRoot = decodeFunctionResult({ abi: registryAbi, functionName: 'computeCanonicalRoot',
      data: await bound.transport.call({ to: registryAddress, data: rootCall }), } as never) as Hex;
    if (liveDerivedRoot.toLowerCase() !== registryRoot.toLowerCase() || derivedRegistry.solidityRoot?.toLowerCase() !== registryRoot.toLowerCase()) {
      throw new ConfigError('PRF_SUCCESSOR_REGISTRY_ROOT_MISMATCH', 'Live Solidity registry encoding does not match the PRF-derived and retained successor root');
    }
    const read = async (functionName: string, args: unknown[] = []): Promise<unknown> => {
      const data = encodeFunctionData({ abi: registryAbi, functionName, args } as never);
      return decodeFunctionResult({ abi: registryAbi, functionName, data: await bound.transport.call({ to: registryAddress, data }) } as never);
    };
    const verifyRegisteredEntry = async (): Promise<void> => {
      const raw = await read('getVerifier', [registryRoot, entry.id]) as unknown as Record<string, unknown> & Array<unknown>;
      const actual = {
        adapter: raw.adapter ?? raw[0], programVKey: raw.programVKey ?? raw[1], programElfSha256: raw.programElfSha256 ?? raw[2],
        programId: raw.programId ?? raw[3], statementSchemaVersionHash: raw.statementSchemaVersionHash ?? raw[4],
        publicValuesSchema: raw.publicValuesSchema ?? raw[5], active: raw.active ?? raw[6],
      };
      const expected = { adapter: entry.adapter, programVKey: entry.programVKey, programElfSha256: entry.programElfSha256,
        programId: entry.programId, statementSchemaVersionHash: entry.statementSchemaVersionHash,
        publicValuesSchema: entry.publicValuesSchema, active: entry.active };
      if (JSON.stringify(Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, String(value).toLowerCase()]))) !==
          JSON.stringify(Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, String(value).toLowerCase()])))) {
        throw new ConfigError('PRF_SUCCESSOR_REGISTRY_READBACK_FAILED', 'On-chain successor verifier metadata differs from the PRF-derived registry entry');
      }
    };
    const count = Number(await read('verifierCount', [registryRoot]));
    const isSealed = Boolean(await read('isSealed', [registryRoot]));
    const registrationId = 'prf/register-successor-verifier';
    const priorRegistration = record.bootstrapActions.find((candidate) => candidate.id === registrationId && candidate.status === 'verified');
    if (!priorRegistration) {
      if (count !== 0 || isSealed) throw new ConfigError('PRF_SUCCESSOR_REGISTRY_UNRECORDED_STATE', 'Successor registry is already mutated without a retained verified registration receipt');
      const actionIndex = record.bootstrapActions.findIndex((candidate) => candidate.id === registrationId);
      const index = actionIndex >= 0 ? actionIndex : record.bootstrapActions.push({ id: registrationId, status: 'planned' }) - 1;
      saveRecord(recordPath, record);
      const result = await executeBootstrapAction({ contract: registryContract, address: registryAddress, function: registerAction.function,
        args: [registryRoot, entry.id, entry.adapter, entry.programVKey, entry.programElfSha256, entry.programId,
          entry.statementSchemaVersionHash, entry.publicValuesSchema].map((value) => ({ kind: 'literal', value })) as ResolvedBinding[],
        addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer, fees, receiptTimeoutMs,
        beforeSubmit: (call) => {
          if (call.from.toLowerCase() !== governor.toLowerCase() || call.args[0] !== registryRoot || call.args[1] !== entry.id ||
              call.args[2] !== entry.adapter || call.args[7] !== entry.publicValuesSchema) {
            throw new ConfigError('PRF_SUCCESSOR_REGISTRY_CALL_MISMATCH', 'Verifier registration call differs from the approved registry entry and governor');
          }
        },
        onTransition: async (transition) => {
          record.bootstrapActions[index] = { id: registrationId, status: transition.status, transactionHash: transition.transactionHash,
            blockNumber: transition.blockNumber?.toString() };
          saveRecord(recordPath, record);
        },
      });
      if (Number(await read('verifierCount', [registryRoot])) !== 1) throw new ConfigError('PRF_SUCCESSOR_REGISTRY_READBACK_FAILED', 'Successor verifier registration did not produce exactly one entry');
      await verifyRegisteredEntry();
      record.bootstrapActions[index] = { id: registrationId, status: 'verified', transactionHash: result.transactionHash,
        blockNumber: result.blockNumber.toString(), verification: 'receipt-success-and-entry-readback' };
      recordFinalAssertion(record, { id: 'prf-successor-verifier-registration', status: 'passed', verifiedAt: new Date().toISOString(),
        detail: JSON.stringify({ registryRoot, entry, transactionHash: result.transactionHash, blockNumber: result.blockNumber.toString(), approvalManifestRoot: approvalEvidence.manifestRoot }) });
      saveRecord(recordPath, record);
    } else if (count !== 1 || (isSealed && !record.bootstrapActions.some((candidate) =>
      candidate.id === 'prf/seal-successor-verifier-registry' && candidate.status === 'verified'))) {
      throw new ConfigError('PRF_SUCCESSOR_REGISTRY_READBACK_FAILED', 'Recorded successor registration no longer matches the expected one-entry registry or its retained seal receipt');
    } else {
      await verifyRegisteredEntry();
    }
    if (planPrefix.stageIds.has('seal-successor-verifier-registry')) {
      const registration = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-verifier-registration' && candidate.status === 'passed');
      if (!registration?.detail) throw new ConfigError('PRF_SUCCESSOR_REGISTRATION_RECEIPT_REQUIRED', 'Successor registry sealing requires retained registration evidence');
      const sealId = 'prf/seal-successor-verifier-registry';
      const priorSeal = record.bootstrapActions.find((candidate) => candidate.id === sealId && candidate.status === 'verified');
      if (!priorSeal) {
        if (Number(await read('verifierCount', [registryRoot])) !== 1 || Boolean(await read('isSealed', [registryRoot]))) {
          throw new ConfigError('PRF_SUCCESSOR_REGISTRY_STATE_INVALID', 'Successor registry must contain its one approved verifier and remain unsealed before sealing');
        }
        const actionIndex = record.bootstrapActions.findIndex((candidate) => candidate.id === sealId);
        const index = actionIndex >= 0 ? actionIndex : record.bootstrapActions.push({ id: sealId, status: 'planned' }) - 1;
        saveRecord(recordPath, record);
        const sealed = await executeBootstrapAction({ contract: registryContract, address: registryAddress, function: sealAction.function,
          args: [{ kind: 'literal', value: registryRoot }], addresses: resolvedAddresses, externalAddresses, transport: bound.transport,
          signer: bound.signer, fees, receiptTimeoutMs,
          beforeSubmit: (call) => {
            if (call.from.toLowerCase() !== governor.toLowerCase() || call.args[0] !== registryRoot) {
              throw new ConfigError('PRF_SUCCESSOR_REGISTRY_SEAL_CALL_MISMATCH', 'Registry seal call differs from approved root and governor');
            }
          },
          onTransition: async (transition) => {
            record.bootstrapActions[index] = { id: sealId, status: transition.status, transactionHash: transition.transactionHash,
              blockNumber: transition.blockNumber?.toString() };
            saveRecord(recordPath, record);
          },
        });
        if (!Boolean(await read('isSealed', [registryRoot]))) throw new ConfigError('PRF_SUCCESSOR_REGISTRY_SEAL_READBACK_FAILED', 'Successor registry seal was not visible after the successful transaction');
        record.bootstrapActions[index] = { id: sealId, status: 'verified', transactionHash: sealed.transactionHash,
          blockNumber: sealed.blockNumber.toString(), verification: 'receipt-success-and-sealed-readback' };
        recordFinalAssertion(record, { id: 'prf-successor-verifier-registry-seal', status: 'passed', verifiedAt: new Date().toISOString(),
          detail: JSON.stringify({ registryRoot, transactionHash: sealed.transactionHash, blockNumber: sealed.blockNumber.toString(), approvalManifestRoot: approvalEvidence.manifestRoot }) });
        saveRecord(recordPath, record);
      } else if (!Boolean(await read('isSealed', [registryRoot]))) {
        throw new ConfigError('PRF_SUCCESSOR_REGISTRY_SEAL_READBACK_FAILED', 'Recorded registry seal is not present on chain');
      }
    }
  }
  if (planPrefix?.stageIds.has('authorize-successor-configuration') && successorTransitionApproval) {
    if (!plan || !initialApprovalEvidence || !authorityTransitionRequest) {
      throw new ConfigError('PRF_AUTHORITY_TRANSITION_INPUT_REQUIRED', 'Authority-state application requires both approval envelopes and the signed transition request');
    }
    const approval = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-transition-approval' && candidate.status === 'passed');
    const transitionRecord = record.finalAssertions.find((candidate) => candidate.id === 'prf-authority-transition-verification' && candidate.status === 'passed');
    const derivationRecord = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-configuration-derivation' && candidate.status === 'passed');
    const registrySealRecord = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-verifier-registry-seal' && candidate.status === 'passed');
    const authorityAddress = resolvedAddresses['prf/governance-authority'];
    const validatorAddress = resolvedAddresses['prf/authority-transition-validator'];
    const genesisAddress = resolvedAddresses['prf/genesis'];
    const registryAddress = resolvedAddresses['prf/verifier-registry'];
    const executorAddress = resolvedAddresses['prf/configuration-executor'];
    const authorityContract = resolved.spec.contracts['prf/governance-authority'];
    const genesisContract = resolved.spec.contracts['prf/genesis'];
    const registryContract = resolved.spec.contracts['prf/verifier-registry'];
    const executorContract = resolved.spec.contracts['prf/configuration-executor'];
    if (!approval?.detail || !transitionRecord?.detail || !derivationRecord?.detail || !registrySealRecord?.detail ||
        !authorityAddress || !validatorAddress || !genesisAddress || !registryAddress || !executorAddress ||
        !authorityContract || !genesisContract || !registryContract || !executorContract) {
      throw new ConfigError('PRF_AUTHORITY_TRANSITION_EVIDENCE_REQUIRED', 'Verified C1 approval, authority transition, deployed contracts and sealed successor registry are required');
    }
    const approvalEvidence = JSON.parse(approval.detail) as { manifestRoot?: string };
    const authorityEvidence = JSON.parse(transitionRecord.detail) as PrfAuthorityTransitionEvidence;
    const derivationEvidence = JSON.parse(derivationRecord.detail) as { derivation?: Record<string, unknown> };
    const derivedTransition = derivationEvidence.derivation?.['configuration-transition'] as Record<string, unknown> | undefined;
    const derivedDecisionRoot = derivationEvidence.derivation?.['decision-root'];
    const successorRoot = sha256RefToBytes32(authorityEvidence.scope['successor-root']);
    const initialAuthorityRoot = sha256RefToBytes32(`sha256:${initialApprovalEvidence.approvedRootBindings.authorityStateRoot.slice(2)}`);
    const policyRoot = sha256RefToBytes32(`sha256:${initialApprovalEvidence.approvedRootBindings.localAuthorityPolicyRoot.slice(2)}`);
    const instanceRoot = sha256RefToBytes32(authorityEvidence.scope['chain-instance-genesis-root']);
    const previousConfigurationRoot = sha256RefToBytes32(String(derivedTransition?.['configuration/parent-root']));
    const newConfigurationRoot = sha256RefToBytes32(String(derivedTransition?.['configuration/new-root']));
    const previousRegistryRoot = sha256RefToBytes32(`sha256:${initialApprovalEvidence.approvedRootBindings.initialVerifierRegistryRoot.slice(2)}`);
    const newRegistryRoot = sha256RefToBytes32(String(derivedTransition?.['verifier-registry/root']));
    const decisionRoot = sha256RefToBytes32(String(derivedDecisionRoot));
    const mutations = authorityEvidence.mutations;
    const authoriseMutation = mutations.filter((mutation) => mutation.kind === 0);
    const proofModeMutation = mutations.filter((mutation) => mutation.kind === 2);
    if (!approvalEvidence.manifestRoot || authorityEvidence.scope['adapter-address'].toLowerCase() !== authorityAddress.toLowerCase() ||
        authorityEvidence.scope['policy-root'] !== `sha256:${initialApprovalEvidence.approvedRootBindings.localAuthorityPolicyRoot.slice(2)}` ||
        authorityEvidence.scope['previous-root'] !== `sha256:${initialApprovalEvidence.approvedRootBindings.authorityStateRoot.slice(2)}` ||
        authorityEvidence.scope['decision-root'] !== derivedDecisionRoot ||
        authorityEvidence.scope['transition-root'] !== derivedDecisionRoot ||
        authorityEvidence.scope['successor-revision'] !== authorityEvidence.scope['previous-revision'] + 1 ||
        authorityEvidence.scope['previous-revision'] !== 0 || authorityEvidence.scope['successor-revision'] !== 1 ||
        authoriseMutation.length !== 1 || proofModeMutation.length !== 1 || mutations.length !== 2) {
      throw new ConfigError('PRF_AUTHORITY_TRANSITION_SCOPE_MISMATCH', 'Verified authority transition does not bind the approved C0/C1 decision, local instance, policy and revision-0 successor');
    }
    const authorise = authoriseMutation[0]!;
    const modeMutation = proofModeMutation[0]!;
    if (authorise.decisionRoot.toLowerCase() !== decisionRoot.toLowerCase() || authorise.targetMode !== 0 ||
        authorise.targetRoot.toLowerCase() !== instanceRoot.toLowerCase() ||
        authorise.parentConfigurationRoot.toLowerCase() !== previousConfigurationRoot.toLowerCase() ||
        authorise.newConfigurationRoot.toLowerCase() !== newConfigurationRoot.toLowerCase() ||
        authorise.parentVerifierRegistryRoot.toLowerCase() !== previousRegistryRoot.toLowerCase() ||
        authorise.newVerifierRegistryRoot.toLowerCase() !== newRegistryRoot.toLowerCase() || authorise.epoch !== 1 ||
        modeMutation.decisionRoot.toLowerCase() !== decisionRoot.toLowerCase() || modeMutation.proofMode !== plan.successorProofMode) {
      throw new ConfigError('PRF_AUTHORITY_TRANSITION_MUTATION_MISMATCH', 'Canonical authority mutations differ from the approved successor configuration and verifier registry');
    }
    const signerAddress = await bound.signer.getAddress();
    await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'governor', args: [], expected: signerAddress,
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'authorityTransitionsEnabled', args: [], expected: true,
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'authorityInstanceGenesis', args: [], expected: { kind: 'contract-address', contract: 'prf/genesis' },
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'authorityTransitionValidator', args: [], expected: validatorAddress,
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: authorityContract, address: authorityAddress, function: 'localAuthorityPolicyRoot', args: [], expected: policyRoot,
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    await assertBootstrap({ contract: genesisContract, address: genesisAddress, function: 'isSealedState', args: [], expected: true,
      addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer });
    const authorityAbi = bundle.loadArtifact(authorityContract.artifactSource, authorityContract.artifact.package,
      authorityContract.artifact.version, authorityContract.artifactName).artifact.abi as Abi;
    const authorityRead = async (functionName: string, args: unknown[] = []): Promise<unknown> => {
      const data = encodeFunctionData({ abi: authorityAbi, functionName, args } as never);
      return decodeFunctionResult({ abi: authorityAbi, functionName, data: await bound.transport.call({ to: authorityAddress, data }) } as never);
    };
    const currentAuthorityRoot = String(await authorityRead('authorityStateRoot'));
    const currentAuthorityRevision = Number(await authorityRead('authorityRevision'));
    const transitionId = 'prf/apply-successor-authority-transition';
    const transitionAction = plan.authorizedConfigurationActions.find((candidate) => candidate.id === 'apply-successor-authority-transition');
    if (!transitionAction || transitionAction.stage !== 'authorize-successor-configuration' || transitionAction.target !== 'prf/governance-authority' ||
        transitionAction.function !== 'applyAuthorityStateTransition') {
      throw new ConfigError('PRF_AUTHORITY_TRANSITION_PLAN_ACTION_INVALID', 'The deployment plan does not declare its authority transition action against the expected adapter');
    }
    const priorTransition = record.bootstrapActions.find((candidate) => candidate.id === transitionId && candidate.status === 'verified');
    if (!priorTransition) {
      if (currentAuthorityRoot.toLowerCase() !== initialAuthorityRoot.toLowerCase() || currentAuthorityRevision !== 0) {
        throw new ConfigError('PRF_AUTHORITY_TRANSITION_UNRECORDED_STATE', 'Authority state already advanced without a retained, verified transition receipt');
      }
      const transitionIndex = record.bootstrapActions.findIndex((candidate) => candidate.id === transitionId);
      const transitionActionIndex = transitionIndex >= 0 ? transitionIndex : record.bootstrapActions.push({ id: transitionId, status: 'planned' }) - 1;
      saveRecord(recordPath, record);
      const transitioned = await executeBootstrapAction({
        contract: authorityContract, address: authorityAddress, function: transitionAction.function, args: [],
        rawArgs: [initialAuthorityRoot, successorRoot, 0, 1,
          authorityEvidence.decisionPreimagesRoot, mutations, authorityEvidence.attestation],
        addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer, fees, receiptTimeoutMs,
        beforeSubmit: (call) => {
          if (call.from.toLowerCase() !== signerAddress.toLowerCase() || call.target.toLowerCase() !== authorityAddress.toLowerCase() ||
              call.args[0] !== initialAuthorityRoot || call.args[1] !== successorRoot ||
              Number(call.args[2]) !== 0 || Number(call.args[3]) !== 1 || call.args[4] !== authorityEvidence.decisionPreimagesRoot ||
              JSON.stringify(call.args[5]) !== JSON.stringify(mutations) || call.args[6] !== authorityEvidence.attestation) {
            throw new ConfigError('PRF_AUTHORITY_TRANSITION_CALL_MISMATCH', 'Signed authority transition call differs from the PRF-verified transition envelope');
          }
        },
        onTransition: async (transition) => {
          record.bootstrapActions[transitionActionIndex] = { id: transitionId, status: transition.status,
            transactionHash: transition.transactionHash, blockNumber: transition.blockNumber?.toString() };
          saveRecord(recordPath, record);
        },
      });
      const postRoot = String(await authorityRead('authorityStateRoot'));
      const postRevision = Number(await authorityRead('authorityRevision'));
      if (postRoot.toLowerCase() !== successorRoot.toLowerCase() || postRevision !== 1) {
        throw new ConfigError('PRF_AUTHORITY_TRANSITION_READBACK_FAILED', 'Successful transition receipt did not produce the approved successor root and revision');
      }
      record.bootstrapActions[transitionActionIndex] = { id: transitionId, status: 'verified', transactionHash: transitioned.transactionHash,
        blockNumber: transitioned.blockNumber.toString(), verification: 'receipt-success-and-successor-root-revision-readback' };
      recordFinalAssertion(record, { id: 'prf-authority-transition-application', status: 'passed', verifiedAt: new Date().toISOString(),
        detail: JSON.stringify({ authorityEvidence, transactionHash: transitioned.transactionHash, blockNumber: transitioned.blockNumber.toString(),
          previousRoot: initialAuthorityRoot, successorRoot: postRoot, previousRevision: 0, successorRevision: postRevision,
          approvalManifestRoot: approvalEvidence.manifestRoot }) });
      saveRecord(recordPath, record);
    } else if (currentAuthorityRoot.toLowerCase() !== successorRoot.toLowerCase() || currentAuthorityRevision !== 1) {
      throw new ConfigError('PRF_AUTHORITY_TRANSITION_READBACK_FAILED', 'Recorded authority transition receipt no longer matches the successor root and revision');
    }
  }
  if (planPrefix?.stageIds.has('apply-successor-configuration') && successorTransitionApproval) {
    if (!plan || !initialApprovalEvidence) throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_APPROVAL_REQUIRED', 'Applying C1 requires the approved initial and successor transition packages');
    const transitionApproval = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-transition-approval' && candidate.status === 'passed');
    const authorityApplication = record.finalAssertions.find((candidate) => candidate.id === 'prf-authority-transition-application' && candidate.status === 'passed');
    const derivationRecord = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-configuration-derivation' && candidate.status === 'passed');
    const registrySeal = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-verifier-registry-seal' && candidate.status === 'passed');
    const executorAddress = resolvedAddresses['prf/configuration-executor'];
    const authorityAddress = resolvedAddresses['prf/governance-authority'];
    const registryAddress = resolvedAddresses['prf/verifier-registry'];
    const executorContract = resolved.spec.contracts['prf/configuration-executor'];
    const authorityContract = resolved.spec.contracts['prf/governance-authority'];
    const registryContract = resolved.spec.contracts['prf/verifier-registry'];
    const action = plan.authorizedConfigurationActions.find((candidate) => candidate.id === 'apply-successor-configuration');
    if (!transitionApproval || !authorityApplication || !derivationRecord?.detail || !registrySeal || !executorAddress || !authorityAddress ||
        !registryAddress || !executorContract || !authorityContract || !registryContract || action?.target !== 'prf/configuration-executor' ||
        action.function !== 'applyConfigurationWithEntitlementProofMode') {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_EVIDENCE_REQUIRED', 'C1 application requires retained approval, authority transition, derivation, sealed registry and declared plan action');
    }
    const derivationEvidence = JSON.parse(derivationRecord.detail) as { derivation?: Record<string, unknown> };
    const derivation = derivationEvidence.derivation;
    const transition = derivation?.['configuration-transition'] as Record<string, unknown> | undefined;
    if (!transition || !derivation?.['decision-root'] || !derivation['configuration/C1-root'] || !derivation['successor-verifier-registry-root']) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_DERIVATION_MISSING', 'Retained C1 derivation is incomplete');
    }
    const decision = sha256RefToBytes32(String(derivation['decision-root']));
    const c0 = sha256RefToBytes32(String(derivation['configuration/C0-root']));
    const c1 = sha256RefToBytes32(String(derivation['configuration/C1-root']));
    const registryRoot = sha256RefToBytes32(String(derivation['successor-verifier-registry-root']));
    const instanceRoot = sha256RefToBytes32(String(derivation['chain-instance-genesis-root']));
    const c0Registry = sha256RefToBytes32(`sha256:${initialApprovalEvidence.approvedRootBindings.initialVerifierRegistryRoot.slice(2)}`);
    const executorArtifact = bundle.loadArtifact(executorContract.artifactSource, executorContract.artifact.package,
      executorContract.artifact.version, executorContract.artifactName).artifact;
    const executorAbi = executorArtifact.abi as Abi;
    const readExecutor = async (functionName: string, args: unknown[] = []): Promise<unknown> => {
      const data = encodeFunctionData({ abi: executorAbi, functionName, args } as never);
      return decodeFunctionResult({ abi: executorAbi, functionName, data: await bound.transport.call({ to: executorAddress, data }) } as never);
    };
    const executorRoot = String(await readExecutor('currentConfigurationRoot'));
    const executorRegistry = String(await readExecutor('currentVerifierRegistryRoot'));
    const executorEpoch = Number(await readExecutor('currentEpoch'));
    const consumed = Boolean(await readExecutor('consumedDecisionRoots', [decision]));
    const executorProofMode = Number(await readExecutor('currentEntitlementProofMode'));
    const applicationId = 'prf/apply-successor-configuration';
    const priorApplication = record.bootstrapActions.find((candidate) => candidate.id === applicationId && candidate.status === 'verified');
    const registryArtifact = bundle.loadArtifact(registryContract.artifactSource, registryContract.artifact.package,
      registryContract.artifact.version, registryContract.artifactName).artifact;
    const registryAbi = registryArtifact.abi as Abi;
    const registrySealed = Boolean(decodeFunctionResult({ abi: registryAbi, functionName: 'isSealed',
      data: await bound.transport.call({ to: registryAddress, data: encodeFunctionData({ abi: registryAbi, functionName: 'isSealed', args: [registryRoot] } as never) }) } as never));
    const atC0 = executorRoot.toLowerCase() === c0.toLowerCase() && executorRegistry.toLowerCase() === c0Registry.toLowerCase() &&
      executorEpoch === 0 && !consumed;
    const atC1 = executorRoot.toLowerCase() === c1.toLowerCase() && executorRegistry.toLowerCase() === registryRoot.toLowerCase() &&
      executorEpoch === 1 && executorProofMode === plan.successorProofMode && consumed;
    if ((!priorApplication && !atC0) || (priorApplication && !atC1) || !registrySealed) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_PRESTATE_MISMATCH', 'Configuration executor is not at approved C0 epoch 0 or the C1 registry is not sealed');
    }
    const authorityAbi = bundle.loadArtifact(authorityContract.artifactSource, authorityContract.artifact.package,
      authorityContract.artifact.version, authorityContract.artifactName).artifact.abi as Abi;
    const authorityCheck = encodeFunctionData({ abi: authorityAbi, functionName: 'isAuthorisedDecisionProofMode',
      args: [decision, 0, instanceRoot, c0, c1, c0Registry, registryRoot, 1, plan.successorProofMode] } as never);
    const decisionAuthorized = Boolean(decodeFunctionResult({ abi: authorityAbi, functionName: 'isAuthorisedDecisionProofMode',
      data: await bound.transport.call({ to: authorityAddress, data: authorityCheck }) } as never));
    if (!decisionAuthorized) throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_NOT_AUTHORIZED', 'Authority adapter does not expose the approved decision and proof-mode authorization');
    if (!priorApplication) {
      const indexExisting = record.bootstrapActions.findIndex((candidate) => candidate.id === applicationId);
      const index = indexExisting >= 0 ? indexExisting : record.bootstrapActions.push({ id: applicationId, status: 'planned' }) - 1;
      saveRecord(recordPath, record);
      const applied = await executeBootstrapAction({
        contract: executorContract, address: executorAddress, function: action.function, args: [],
        rawArgs: [decision, c1, registryRoot, 1, 0, instanceRoot, [], plan.successorProofMode],
        addresses: resolvedAddresses, externalAddresses, transport: bound.transport, signer: bound.signer, fees, receiptTimeoutMs,
        beforeSubmit: (call) => {
          if (call.target.toLowerCase() !== executorAddress.toLowerCase() || call.args.length !== 8 ||
              String(call.args[0]).toLowerCase() !== decision.toLowerCase() || String(call.args[1]).toLowerCase() !== c1.toLowerCase() ||
              String(call.args[2]).toLowerCase() !== registryRoot.toLowerCase() || Number(call.args[3]) !== 1 ||
              Number(call.args[4]) !== 0 || String(call.args[5]).toLowerCase() !== instanceRoot.toLowerCase() ||
              !Array.isArray(call.args[6]) || call.args[6].length !== 0 || Number(call.args[7]) !== plan.successorProofMode) {
            throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_CALL_MISMATCH', 'C1 application call differs from approved derivation, direct instance target and proof mode');
          }
        },
        onTransition: async (transitionState) => {
          record.bootstrapActions[index] = { id: applicationId, status: transitionState.status,
            transactionHash: transitionState.transactionHash, blockNumber: transitionState.blockNumber?.toString() };
          saveRecord(recordPath, record);
        },
      });
      const postRoot = String(await readExecutor('currentConfigurationRoot'));
      const postRegistry = String(await readExecutor('currentVerifierRegistryRoot'));
      const postEpoch = Number(await readExecutor('currentEpoch'));
      const postProofMode = Number(await readExecutor('currentEntitlementProofMode'));
      const postConsumed = Boolean(await readExecutor('consumedDecisionRoots', [decision]));
      if (postRoot.toLowerCase() !== c1.toLowerCase() || postRegistry.toLowerCase() !== registryRoot.toLowerCase() ||
          postEpoch !== 1 || postProofMode !== plan.successorProofMode || !postConsumed) {
        throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_READBACK_FAILED', 'Successful C1 receipt did not update and consume the approved transition exactly once');
      }
      record.bootstrapActions[index] = { id: applicationId, status: 'verified', transactionHash: applied.transactionHash,
        blockNumber: applied.blockNumber.toString(), verification: 'receipt-success-and-C1-epoch-registry-proof-mode-readback' };
      recordFinalAssertion(record, { id: 'prf-successor-configuration-application', status: 'passed', verifiedAt: new Date().toISOString(),
        detail: JSON.stringify({ decisionRoot: decision, configurationRoot: postRoot, verifierRegistryRoot: postRegistry,
          epoch: postEpoch, entitlementProofMode: postProofMode, consumed: postConsumed, transactionHash: applied.transactionHash,
          blockNumber: applied.blockNumber.toString(), transitionApproval: transitionApproval.detail }) });
      saveRecord(recordPath, record);
    } else if (!atC1) {
      throw new ConfigError('PRF_SUCCESSOR_CONFIGURATION_READBACK_FAILED', 'Recorded C1 transaction no longer matches its on-chain state');
    }
  }
  if (postC1DeploymentSteps.length > 0) {
    const application = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-configuration-application' && candidate.status === 'passed');
    const applicationAction = record.bootstrapActions.find((candidate) => candidate.id === 'prf/apply-successor-configuration' && candidate.status === 'verified');
    let activeSnapshot: Record<string, unknown> | undefined;
    try { activeSnapshot = application?.detail ? JSON.parse(application.detail) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
    if (!plan || !applicationAction || !activeSnapshot || typeof activeSnapshot.configurationRoot !== 'string' ||
        activeSnapshot.epoch !== 1 || activeSnapshot.consumed !== true || activeSnapshot.transactionHash !== applicationAction.transactionHash) {
      throw new ConfigError('PRF_POST_C1_DEPLOYMENT_GATE_REQUIRED', 'Post-C1 contracts cannot be deployed without a verified configuration-application receipt and readback');
    }
    resolved.spec = bindStatementAdmissionSnapshot(resolved.spec, plan, activeSnapshot.configurationRoot, Number(activeSnapshot.epoch));
    executionSpecHash = materializeExecutionSpec(resolved.spec, resolved.specHash, deployer, externalAddresses).executionSpecHash;
    record.executionSpecHash = executionSpecHash;
    saveRecord(recordPath, record);
    const postC1Targets = new Set(postC1DeploymentSteps.map((step) => step.logicalId));
    const unsupportedLateBootstrap = (resolved.spec.deployment.bootstrapActions ?? []).find((action) => postC1Targets.has(action.target));
    if (unsupportedLateBootstrap) {
      throw new ConfigError('PLAN_POST_C1_BOOTSTRAP_UNSUPPORTED', `Post-C1 target '${unsupportedLateBootstrap.target}' has bootstrap action '${unsupportedLateBootstrap.id}' without a staged executor`);
    }
    for (const step of postC1DeploymentSteps) await deployStep(step);
  }
  for (const assertion of (resolved.spec.deployment.bootstrapAssertions ?? []).filter((candidate) => resolvedAddresses[candidate.target])) {
    try {
      await assertBootstrap({
        ...assertion,
        contract: resolved.spec.contracts[assertion.target]!,
        address: resolvedAddresses[assertion.target]!,
        addresses: resolvedAddresses,
        externalAddresses,
        transport: bound.transport,
        signer: bound.signer,
      });
      recordFinalAssertion(record, { id: assertion.id, status: 'passed', verifiedAt: new Date().toISOString() });
    } catch (error) {
      recordFinalAssertion(record, { id: assertion.id, status: 'failed', verifiedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : String(error) });
      saveRecord(recordPath, record);
      throw error;
    }
    saveRecord(recordPath, record);
  }

  // Seal the record against the block that follows the last assertion so the
  // manifest can carry an independently checkable block identity.
  const finalBlock = await bound.transport.getBlock();
  record.status = partialPlanExecution ? 'partial' : 'complete';
  record.blockNumber = finalBlock.number.toString();
  record.blockHash = finalBlock.hash;
  record.deployedAt = new Date().toISOString();
  saveRecord(recordPath, record);

  const manifestBase = {
    architectureSpecHash: resolved.specHash,
    executionSpecHash,
    deploymentId: record.deploymentId,
    chain: { id: record.chainId, blockNumber: finalBlock.number.toString(), blockHash: finalBlock.hash },
    deployer,
    contracts: Object.values(record.contracts).map((contract) => ({
      logicalId: contract.logicalId,
      address: contract.address,
      artifact: contract.artifact,
      deploymentTx: contract.transactionHash,
      blockNumber: contract.blockNumber,
    })),
    bootstrapActions: record.bootstrapActions,
    finalAssertions: record.finalAssertions,
  };
  const manifest: DeploymentManifest = externalContractObservations.length > 0
    ? { ...manifestBase, type: 'protocol-deployment-manifest/v2', externalContracts: externalContractObservations } as DeploymentManifestV2
    : { ...manifestBase, type: 'protocol-deployment-manifest/v1' };
  const manifestRoot = computeManifestRoot(manifest);
  const manifestVersion = manifest.type.endsWith('/v2') ? 'v2' : 'v1';
  const manifestPath = path.join(deploymentsDir, `${deploymentKey}.${manifestRoot.slice(2, 14)}.deployment-manifest.${manifestVersion}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (!partialPlanExecution) {
    const candidatePath = path.join(deploymentsDir, `${deploymentKey}.${manifestRoot.slice(2, 14)}.registry-binding-candidate.v1.json`);
    fs.writeFileSync(candidatePath, JSON.stringify(registryBindingCandidate(manifest, resolved.spec.deployment.registryRoots ?? [], resolved.spec.deployment.localOnly ?? false), null, 2) + '\n');
  }
  if (plan) {
    const resolvedEvidenceInput = {
      specHash: resolved.specHash, executionSpecHash, environment: resolved.spec.environment, spec: resolved.spec,
    };
    const resolvedSpecEvidence = retainedResolvedSpecEvidence(resolvedEvidenceInput);
    const resolvedSpecSha256 = retainedResolvedSpecSha256(resolvedEvidenceInput);
    const resolvedSpecPath = path.join(deploymentsDir, `${deploymentKey}.${resolvedSpecSha256.slice(0, 12)}.resolved-spec.v1.json`);
    const resolvedSpecContent = `${JSON.stringify(resolvedSpecEvidence, null, 2)}\n`;
    if (fs.existsSync(resolvedSpecPath) && fs.readFileSync(resolvedSpecPath, 'utf8') !== resolvedSpecContent) {
      throw new ConfigError('PLAN_EXECUTION_RECEIPT_CONFLICT', `Refusing to overwrite incompatible resolved-spec evidence '${resolvedSpecPath}'`);
    }
    if (!fs.existsSync(resolvedSpecPath)) fs.writeFileSync(resolvedSpecPath, resolvedSpecContent, { flag: 'wx' });
    const selectedContracts = Object.entries(plan.contracts).map(([logicalId, source]) => ({ logicalId, ...source }));
    const stageStatuses = new Map<string, string>();
    const stages = plan.stages.map((stage) => {
      const prerequisitesSatisfied = stage.dependsOn.every((dependency) => ['verified', 'not-applicable'].includes(stageStatuses.get(dependency) ?? ''));
      if (stage.kind === 'deploy') {
        const members = selectedContracts.filter((entry) => 'stage' in entry && entry.stage === stage.id && (entry.kind === 'deploy' || entry.kind === 'local-fixture'));
        const outputs: Record<string, unknown> = Object.fromEntries(members.flatMap((entry) => {
          const deployed = record.contracts[entry.logicalId];
          if (!deployed || record.execution[entry.logicalId]?.status !== 'verified') return [];
          const outputName = Object.entries(stage.contractOutputs ?? {}).find(([, logicalId]) => logicalId === entry.logicalId)?.[0] ?? entry.logicalId;
          return [[outputName, {
            address: deployed.address,
            transactionHash: deployed.transactionHash,
            blockNumber: deployed.blockNumber,
            runtimeBytecodeSha256: deployed.artifact.runtimeBytecodeSha256,
          }]];
        }));
        // The genesis deployment stage also publishes a runtime identity that
        // was independently observed by seal preflight. It is not a contract
        // address output and must remain bound to that retained evidence.
        if (stage.id === 'deploy-genesis') {
          const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-genesis-seal-preflight' && candidate.status === 'passed');
          let evidence: Record<string, unknown> | undefined;
          try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains pending */ }
          const codeHash = genesisRuntimeCodeHashFromPreflight(evidence);
          if (typeof codeHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(codeHash)) outputs.genesisRuntimeCodeHash = codeHash;
        }
        const mappedOutputs = Object.keys(stage.contractOutputs ?? {});
        const complete = members.length > 0 && mappedOutputs.every((name) => Object.hasOwn(outputs, name)) &&
          (stage.id !== 'deploy-genesis' || Object.hasOwn(outputs, 'genesisRuntimeCodeHash'));
        const status = !prerequisitesSatisfied ? 'blocked' : complete ? 'verified' : 'pending';
        stageStatuses.set(stage.id, status);
        return { id: stage.id, kind: stage.kind, status, outputs };
      }
      if (stage.kind === 'external-preflight') {
        const members = selectedContracts.filter((entry) => 'stage' in entry && entry.stage === stage.id && entry.kind === 'external');
        const observations = (record.externalContracts ?? []).filter((observation) => members.some((member) => member.logicalId === observation.logicalId));
        const status = members.length === 0 ? 'not-applicable' : !prerequisitesSatisfied ? 'blocked' : observations.length === members.length ? 'verified' : 'pending';
        stageStatuses.set(stage.id, status);
        return { id: stage.id, kind: stage.kind, status, observations };
      }
      if (stage.kind === 'derive-canonical-roots' && stage.id === 'derive-chain-instance-root') {
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-genesis-seal-preflight' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* left pending below */ }
        if (evidence && evidence.schema === 'prf-chain-instance-seal-preflight.v2' && typeof evidence.computedRoot === 'string') {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: { chainInstanceGenesisRoot: evidence.computedRoot }, evidence: {
            type: 'prf-genesis-seal-preflight', manifestRoot: evidence.manifestRoot,
            verifierOutputSha256: evidence.outputSha256,
          } };
        }
      }
      if (stage.kind === 'derive-canonical-roots' && stage.id === 'derive-registry-roots') {
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-registry-derivation' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* left pending below */ }
        if (evidence && evidence.schema === 'prf-verifier-registry-derivation-evidence.v1' && typeof evidence.root === 'string') {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: { successorRegistryRoot: evidence.root }, evidence };
        }
      }
      if (stage.kind === 'derive-canonical-roots' && stage.id === 'derive-successor-configuration') {
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-configuration-derivation' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains pending */ }
        const derivation = evidence?.derivation as Record<string, unknown> | undefined;
        if (planPrefix?.stageIds.has(stage.id) && evidence?.schema === 'prf-successor-configuration-evidence.v1' && derivation) {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: {
            decisionRoot: derivation['decision-root'],
            successorConfigurationRoot: derivation['configuration/C1-root'],
            configurationEpoch: (derivation['configuration-transition'] as Record<string, unknown>)?.epoch,
            targetRoot: (derivation['configuration-transition'] as Record<string, unknown>)?.target &&
              ((derivation['configuration-transition'] as Record<string, unknown>).target as Record<string, unknown>)['target/root'],
          }, evidence: { type: 'prf-successor-configuration-derivation', requestSha256: evidence.requestSha256,
            verifierOutputSha256: evidence.outputSha256, qualification: evidence.qualification } };
        }
      }
      if (stage.kind === 'verify' && stage.id === 'verify-successor-transition-approval') {
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-transition-approval' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains not executed */ }
        if (evidence?.schema === 'prf-successor-transition-approval-verification.v1') {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: { successorTransitionApprovalEvidence: {
            manifestRoot: evidence.manifestRoot, scope: evidence.scope,
          } }, evidence: { type: 'prf-successor-transition-approval', outputSha256: evidence.outputSha256,
            inputSha256: (evidence.inputs as Array<{ sha256: string }>).map((item) => item.sha256) } };
        }
      }
      if (stage.kind === 'seal-genesis') {
        const action = record.bootstrapActions.find((candidate) => candidate.id === 'prf/seal-genesis' && candidate.status === 'verified');
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-genesis-seal-result' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* left pending below */ }
        if (action && evidence && evidence.schema === 'prf-chain-instance-seal-result.v1' && typeof evidence.chainInstanceGenesisRoot === 'string') {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: { sealedGenesisObservation: {
            chainInstanceGenesisRoot: evidence.chainInstanceGenesisRoot, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
          } }, evidence: { type: 'prf-genesis-seal-result', verifierOutputSha256: evidence.outputSha256, preflightOutputSha256: evidence.preflightOutputSha256 } };
        }
      }
      if (stage.kind === 'authorize-configuration' && stage.id === 'seal-empty-verifier-registry') {
        const action = record.bootstrapActions.find((candidate) => candidate.id === 'prf/seal-empty-verifier-registry' && candidate.status === 'verified');
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-empty-registry-seal-result' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains pending */ }
        if (action && evidence?.schema === 'prf-empty-registry-seal-result.v1') {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: { emptyRegistryReceipt: {
            root: evidence.root, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
          } }, evidence };
        }
      }
      if (stage.kind === 'authorize-configuration' && stage.id === 'register-successor-verifier') {
        const action = record.bootstrapActions.find((candidate) => candidate.id === 'prf/register-successor-verifier' && candidate.status === 'verified');
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-verifier-registration' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains pending */ }
        if (prerequisitesSatisfied && action && evidence?.registryRoot && evidence.transactionHash === action.transactionHash) {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: { registrationReceipt: {
            registryRoot: evidence.registryRoot, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
          } }, evidence };
        }
      }
      if (stage.kind === 'authorize-configuration' && stage.id === 'seal-successor-verifier-registry') {
        const action = record.bootstrapActions.find((candidate) => candidate.id === 'prf/seal-successor-verifier-registry' && candidate.status === 'verified');
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-verifier-registry-seal' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains pending */ }
        if (prerequisitesSatisfied && action && evidence?.registryRoot && evidence.transactionHash === action.transactionHash) {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: { sealedSuccessorRegistryObservation: {
            registryRoot: evidence.registryRoot, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
          } }, evidence };
        }
      }
      if (stage.kind === 'authorize-configuration' && stage.id === 'authorize-successor-configuration') {
        const action = record.bootstrapActions.find((candidate) => candidate.id === 'prf/apply-successor-authority-transition' && candidate.status === 'verified');
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-authority-transition-application' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains pending */ }
        if (prerequisitesSatisfied && action && evidence && typeof evidence.successorRoot === 'string' && evidence.successorRevision === 1 &&
            evidence.transactionHash === action.transactionHash) {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: {
            authorityTransitionReceipt: { transactionHash: action.transactionHash, blockNumber: action.blockNumber },
            successorAuthorityStateRoot: evidence.successorRoot,
          }, evidence: { type: 'prf-authority-transition-application', approvalManifestRoot: evidence.approvalManifestRoot,
            previousRoot: evidence.previousRoot, previousRevision: evidence.previousRevision,
            successorRoot: evidence.successorRoot, successorRevision: evidence.successorRevision,
            scope: (evidence.authorityEvidence as Record<string, unknown> | undefined)?.scope,
            decisionPreimagesRoot: (evidence.authorityEvidence as Record<string, unknown> | undefined)?.decisionPreimagesRoot,
            executionMutationRoot: (evidence.authorityEvidence as Record<string, unknown> | undefined)?.executionMutationRoot,
            verifierOutputSha256: (evidence.authorityEvidence as Record<string, unknown> | undefined)?.outputSha256 } };
        }
      }
      if (stage.kind === 'authorize-configuration' && stage.id === 'apply-successor-configuration') {
        const action = record.bootstrapActions.find((candidate) => candidate.id === 'prf/apply-successor-configuration' && candidate.status === 'verified');
        const assertion = record.finalAssertions.find((candidate) => candidate.id === 'prf-successor-configuration-application' && candidate.status === 'passed');
        let evidence: Record<string, unknown> | undefined;
        try { evidence = assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { /* remains pending */ }
        if (prerequisitesSatisfied && action && evidence && typeof evidence.configurationRoot === 'string' && typeof evidence.verifierRegistryRoot === 'string' &&
            evidence.epoch === 1 && evidence.consumed === true && evidence.transactionHash === action.transactionHash) {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs: {
            configurationTransitionReceipt: { transactionHash: action.transactionHash, blockNumber: action.blockNumber },
            activeConfigurationRoot: evidence.configurationRoot, activeConfigurationEpoch: evidence.epoch,
            activeEntitlementProofMode: evidence.entitlementProofMode,
          }, evidence: { type: 'prf-successor-configuration-application', decisionRoot: evidence.decisionRoot,
            configurationRoot: evidence.configurationRoot, verifierRegistryRoot: evidence.verifierRegistryRoot,
            epoch: evidence.epoch, entitlementProofMode: evidence.entitlementProofMode, consumed: evidence.consumed } };
        }
      }
      if (stage.kind === 'derive-canonical-roots' && planPrefix?.stageIds.has(stage.id) && initialApprovalEvidence) {
        const approved = initialApprovalEvidence.approvedRootBindings;
        const outputs = stage.id === 'derive-genesis-roots'
          ? { protocolGenesisRoot: approved.protocolGenesisRoot, authorityStateRoot: approved.authorityStateRoot, emptyRegistryRoot: approved.initialVerifierRegistryRoot }
          : stage.id === 'derive-initial-configuration' ? { initialConfigurationRoot: approved.initialConfigurationRoot } : undefined;
        if (outputs) {
          stageStatuses.set(stage.id, 'verified');
          return { id: stage.id, kind: stage.kind, status: 'verified', outputs, evidence: {
            type: 'prf-initial-input-approval', manifestRoot: initialApprovalEvidence.manifestRoot,
            verifierOutputSha256: initialApprovalEvidence.outputSha256,
            inputSha256: initialApprovalEvidence.inputs.map((input) => input.sha256),
          } };
        }
      }
      stageStatuses.set(stage.id, 'not-executed');
      return { id: stage.id, kind: stage.kind, status: 'not-executed' };
    });
    const planBody = {
      type: 'protocol-deployment-plan-execution/v1' as const,
      executionStatus: partialPlanExecution ? 'partial' as const : 'complete' as const,
      planId: plan.planId,
      planHash: deploymentPlanHash(plan),
      environment: resolved.spec.environment,
      chainId: resolved.spec.chain.chainId,
      localOnly: plan.localOnly,
      selectedUnits: plan.selectedUnits,
      excludedUnits: plan.excludedUnits,
      selectedContracts,
      manifestRoot,
      resolvedSpecSha256,
      stageOutputBindings,
      stages,
    };
    const planRoot = planExecutionRoot(planBody);
    const planExecution = { ...planBody, planExecutionRoot: planRoot };
    const planExecutionPath = path.join(deploymentsDir, `${deploymentKey}.${planRoot.slice(2, 14)}.deployment-plan-execution.v1.json`);
    if (fs.existsSync(planExecutionPath) && fs.readFileSync(planExecutionPath, 'utf8') !== JSON.stringify(planExecution, null, 2) + '\n') {
      throw new ConfigError('PLAN_EXECUTION_RECEIPT_CONFLICT', `Refusing to overwrite incompatible plan execution evidence '${planExecutionPath}'`);
    }
    if (!fs.existsSync(planExecutionPath)) fs.writeFileSync(planExecutionPath, JSON.stringify(planExecution, null, 2) + '\n', { flag: 'wx' });
    const verifiedStages = stages.filter((stage) => stage.status === 'verified').length;
    const blockedStages = stages.filter((stage) => stage.status === 'blocked').length;
    const unexecutedStages = stages.filter((stage) => stage.status === 'not-executed' || stage.status === 'pending').length;
    console.log(`   plan execution receipt: ${planExecutionPath} (${verifiedStages} verified; ${blockedStages} blocked; ${unexecutedStages} not executed)`);
    console.log(`   retained resolved spec: ${resolvedSpecPath} (sha256:${resolvedSpecSha256})`);
  }
  console.log(partialPlanExecution
    ? `\n⚠️ Executed ${results.length} contract(s) in a partial plan prefix; record written to ${recordPath}`
    : `\n✅ Deployed ${results.length} contract(s); record written to ${recordPath}`);
  console.log(`   ${partialPlanExecution ? 'partial-prefix manifest' : 'immutable manifest'}: ${manifestPath} (${manifestRoot})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
