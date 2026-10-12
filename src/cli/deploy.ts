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
import { assertPlanDeployable, unsupportedDeploymentPrerequisite } from '../deployment/successor-plan';

interface DeployOptions {
  bundle: BundleConsumer;
  deploymentsDir: string;
  resume: boolean;
  dryRun: boolean;
  assumeYes: boolean;
  fees?: TxFees;
  receiptTimeoutMs?: number;
  plan?: NonNullable<Awaited<ReturnType<typeof resolveDeployment>>['deploymentPlan']>;
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
  const legacyFlat = process.argv.includes('--legacy-flat');
  const profileDir = profileArg >= 0 ? path.resolve(process.cwd(), process.argv[profileArg + 1]!) : undefined;
  if (!environment || (planArg !== undefined) === legacyFlat) {
    console.error('Usage: deploy.ts <environment> (--plan <plan.json> | --legacy-flat) [--profile <dir>] [--fixtures <dir>] [--deployment-key <key>] [--resume] [--dry-run] [--yes] [--max-fee <wei>] [--priority-fee <wei>] [--receipt-timeout-ms <ms>]');
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

  const resolved = resolveDeployment({
    configDir,
    environment,
    fixtureRoot,
    profileDir,
    preferFixtures,
    requirePinnedProvenance,
    deploymentPlanFile: planArg ? path.resolve(process.cwd(), planArg) : undefined,
  });
  if (resolved.deploymentPlan && !resume) {
    assertPlanDeployable(resolved.deploymentPlan);
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

  const options: DeployOptions = { bundle, deploymentsDir, resume, dryRun, assumeYes, fees, receiptTimeoutMs, plan: resolved.deploymentPlan };
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
  const { bundle, deploymentsDir, resume, dryRun, fees, receiptTimeoutMs, plan } = options;
  const chainId = await bound.transport.getChainId();
  assertChainIdMatches({ chainId: resolved.spec.chain.chainId, environment }, chainId);
  const deployer = await bound.signer.getAddress();
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
  if (plan) {
    const unavailable = unsupportedDeploymentPrerequisite(plan);
    const completePriorDeployment = resume && resolved.spec.deployment.steps.every((step) =>
      existing?.contracts[step.logicalId] && existing.execution[step.logicalId]?.status === 'verified');
    if (unavailable && !completePriorDeployment) {
      throw new ConfigError('PLAN_STAGE_EXECUTOR_UNAVAILABLE', `Cannot resume through unimplemented stage '${unavailable.stage}' required by '${unavailable.contract}'`);
    }
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
  const { executionSpecHash } = materializeExecutionSpec(resolved.spec, resolved.specHash, deployer, externalAddresses);
  record.executionSpecHash = executionSpecHash;
  // Persist before the first transaction; every subsequent engine transition is durable.
  saveRecord(recordPath, record);

  const results: DeployContractResult[] = [];
  const resolvedAddresses: Record<string, `0x${string}`> = Object.fromEntries(
    Object.entries(resolved.spec.externalContracts ?? {}).map(([logicalId, dependency]) => [logicalId, dependency.address as `0x${string}`]),
  );
  const executedBootstrapActions = new Set<string>(record.bootstrapActions.filter((action) => action.status === 'verified').map((action) => action.id));
  for (const step of resolved.spec.deployment.steps) {
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
  for (const assertion of resolved.spec.deployment.bootstrapAssertions ?? []) {
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
  record.status = 'complete';
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
  const candidatePath = path.join(deploymentsDir, `${deploymentKey}.${manifestRoot.slice(2, 14)}.registry-binding-candidate.v1.json`);
  fs.writeFileSync(candidatePath, JSON.stringify(registryBindingCandidate(manifest, resolved.spec.deployment.registryRoots ?? [], resolved.spec.deployment.localOnly ?? false), null, 2) + '\n');
  if (plan) {
    const selectedContracts = Object.entries(plan.contracts).map(([logicalId, source]) => ({ logicalId, ...source }));
    const stageStatuses = new Map<string, string>();
    const stages = plan.stages.map((stage) => {
      const prerequisitesSatisfied = stage.dependsOn.every((dependency) => ['verified', 'not-applicable'].includes(stageStatuses.get(dependency) ?? ''));
      if (stage.kind === 'deploy') {
        const members = selectedContracts.filter((entry) => 'stage' in entry && entry.stage === stage.id && (entry.kind === 'deploy' || entry.kind === 'local-fixture'));
        const outputs = Object.fromEntries(members.flatMap((entry) => {
          const deployed = record.contracts[entry.logicalId];
          if (!deployed || record.execution[entry.logicalId]?.status !== 'verified') return [];
          return [[entry.logicalId, {
            address: deployed.address,
            transactionHash: deployed.transactionHash,
            blockNumber: deployed.blockNumber,
            runtimeBytecodeSha256: deployed.artifact.runtimeBytecodeSha256,
          }]];
        }));
        const complete = members.length > 0 && Object.keys(outputs).length === members.length;
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
      stageStatuses.set(stage.id, 'not-executed');
      return { id: stage.id, kind: stage.kind, status: 'not-executed' };
    });
    const planBody = {
      type: 'protocol-deployment-plan-execution/v1' as const,
      planId: plan.planId,
      planHash: deploymentPlanHash(plan),
      environment: resolved.spec.environment,
      chainId: resolved.spec.chain.chainId,
      localOnly: plan.localOnly,
      selectedUnits: plan.selectedUnits,
      excludedUnits: plan.excludedUnits,
      selectedContracts,
      manifestRoot,
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
  }
  console.log(`\n✅ Deployed ${results.length} contract(s); record written to ${recordPath}`);
  console.log(`   immutable manifest: ${manifestPath} (${manifestRoot})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
