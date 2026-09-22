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
import { randomUUID } from 'crypto';
import { resolveDeployment } from '../resolve-deployment';
import { loadRuntime } from '../config/load';
import { BundleConsumer, FixtureBundleLocator } from '../artifacts/bundle';
import { bindRuntime } from '../runtime/bind';
import { deployContract, type DeployContractResult } from '../deployment/engine';
import { emptyRecord, loadRecord, saveRecord, recordPathFor, artifactIdentityOf, type DeploymentRecord } from '../deployment/record';
import { materializeExecutionSpec } from '../deployment/execution-spec';
import { computeManifestRoot, registryBindingCandidate, type DeploymentManifestV1 } from '../deployment/manifest';
import { executeBootstrapAction, assertBootstrap } from '../deployment/bootstrap';
import type { ResolvedBinding } from '../canonical';

function bootstrapBindingAvailable(binding: ResolvedBinding, addresses: Record<string, `0x${string}`>): boolean {
  if (binding.kind === 'contract-address' || binding.kind === 'runtime-code-hash') return Boolean(addresses[binding.contract]);
  if (binding.kind === 'array') return binding.values.every((value) => bootstrapBindingAvailable(value, addresses));
  return true;
}

async function main(): Promise<void> {
  const environment = process.argv[2];
  const profileArg = process.argv.indexOf('--profile');
  const deploymentKeyArg = process.argv.indexOf('--deployment-key');
  const resume = process.argv.includes('--resume');
  const profileDir = profileArg >= 0 ? path.resolve(process.cwd(), process.argv[profileArg + 1]!) : undefined;
  const deploymentKey = deploymentKeyArg >= 0 ? process.argv[deploymentKeyArg + 1] : environment;
  if (!environment) {
    console.error('Usage: deploy.ts <environment>');
    process.exit(2);
  }
  const configDir = path.resolve(process.cwd(), 'config');
  const fixtureRoot = path.resolve(process.cwd(), 'fixtures', 'packages');
  const deploymentsDir = path.resolve(process.cwd(), 'deployments');

  const resolved = resolveDeployment({ configDir, environment, fixtureRoot, profileDir });
  const runtime = loadRuntime(configDir, 'local');
  const bound = await bindRuntime(runtime, environment, configDir);

  if (!deploymentKey) {
    console.error('Usage: deploy.ts <environment> [--profile <dir>] [--deployment-key <key>] [--resume]');
    process.exit(2);
  }

  try {
    await run(resolved, bound, deploymentKey, configDir, fixtureRoot, deploymentsDir, resume);
  } finally {
    if (bound.anvil) await bound.anvil.stop().catch(() => {});
  }
}

async function run(
  resolved: Awaited<ReturnType<typeof resolveDeployment>>,
  bound: Awaited<ReturnType<typeof bindRuntime>>,
  deploymentKey: string,
  configDir: string,
  fixtureRoot: string,
  deploymentsDir: string,
  resume: boolean,
): Promise<void> {
  const chainId = await bound.transport.getChainId();
  if (chainId !== resolved.spec.chain.chainId) {
    throw new Error(`Configured chain id ${resolved.spec.chain.chainId} differs from connected ${chainId}`);
  }
  const deployer = await bound.signer.getAddress();
  const bundle = new BundleConsumer(new FixtureBundleLocator(fixtureRoot));

  const recordPath = recordPathFor(deploymentsDir, deploymentKey);
  const existing = resume ? loadRecord(recordPath) : null;
  if (existing && (existing.specHash !== resolved.specHash || existing.deployer !== deployer)) {
    throw new Error('Cannot resume deployment: existing record does not match the resolved spec or deployer');
  }
  const record: DeploymentRecord = existing ?? emptyRecord({
    specHash: resolved.specHash,
    environment: deploymentKey,
    chainId: resolved.spec.chain.chainId,
  });
  record.deploymentId ??= randomUUID();
  record.deployer = deployer;
  const externalAddresses = Object.fromEntries(Object.entries(resolved.spec.externalAddresses ?? {})) as Record<string, `0x${string}`>;
  const { executionSpecHash } = materializeExecutionSpec(resolved.spec, resolved.specHash, deployer, externalAddresses);
  record.executionSpecHash = executionSpecHash;
  // Persist before the first transaction; every subsequent engine transition is durable.
  saveRecord(recordPath, record);

  const results: DeployContractResult[] = [];
  const resolvedAddresses: Record<string, `0x${string}`> = {};
  const executedBootstrapActions = new Set<string>(record.bootstrapActions.filter((action) => action.status === 'verified').map((action) => action.id));
  for (const step of resolved.spec.deployment.steps) {
    const prior = record.contracts[step.logicalId];
    if (resume && prior && record.execution[step.logicalId]?.status === 'verified') {
      resolvedAddresses[step.logicalId] = prior.address;
      results.push({ logicalId: step.logicalId, artifactName: prior.artifact.artifactName, address: prior.address, transactionHash: prior.transactionHash, blockNumber: BigInt(prior.blockNumber), mode: prior.mode, deployedParameters: prior.deployedParameters });
      console.log(`  ↻ ${step.logicalId} already verified at ${prior.address}`);
      continue;
    }
    const res = await deployContract({
      spec: resolved.spec,
      logicalId: step.logicalId,
      bundle,
      transport: bound.transport,
      signer: bound.signer,
      resolvedAddresses,
      externalAddresses,
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

    // Bootstrap actions run immediately after their target is deployed. This permits
    // deployment graphs whose next constructor requires the target's initialized state
    // (for example, sealing genesis before constructing the configuration executor).
    for (const action of (resolved.spec.deployment.bootstrapActions ?? []).filter((candidate) =>
      !executedBootstrapActions.has(candidate.id) &&
      !(resume && record.bootstrapActions.some((completed) => completed.id === candidate.id && completed.status === 'verified')) &&
      resolvedAddresses[candidate.target] && candidate.args.every((arg) => bootstrapBindingAvailable(arg, resolvedAddresses)))) {
      record.bootstrapActions.push({ id: action.id, status: 'planned' });
      const actionIndex = record.bootstrapActions.length - 1;
      saveRecord(recordPath, record);
      try {
        const result = await executeBootstrapAction({
          ...action,
          contract: resolved.spec.contracts[action.target]!,
          address: resolvedAddresses[action.target]!,
          addresses: resolvedAddresses,
          transport: bound.transport,
          signer: bound.signer,
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
        transport: bound.transport,
        signer: bound.signer,
      });
      record.finalAssertions.push({ id: assertion.id, status: 'passed', verifiedAt: new Date().toISOString() });
    } catch (error) {
      record.finalAssertions.push({ id: assertion.id, status: 'failed', verifiedAt: new Date().toISOString(), detail: error instanceof Error ? error.message : String(error) });
      saveRecord(recordPath, record);
      throw error;
    }
    saveRecord(recordPath, record);
  }

  record.status = 'complete';
  record.blockNumber = (await bound.transport.getBlockNumber()).toString();
  record.deployedAt = new Date().toISOString();
  saveRecord(recordPath, record);

  const manifest: DeploymentManifestV1 = {
    type: 'protocol-deployment-manifest/v1',
    architectureSpecHash: resolved.specHash,
    executionSpecHash,
    deploymentId: record.deploymentId,
    chain: { id: record.chainId, blockNumber: record.blockNumber },
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
    verificationRoot: executionSpecHash,
  };
  const manifestRoot = computeManifestRoot(manifest);
  const manifestPath = path.join(deploymentsDir, `${deploymentKey}.${manifestRoot.slice(2, 14)}.deployment-manifest.v1.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const candidatePath = path.join(deploymentsDir, `${deploymentKey}.${manifestRoot.slice(2, 14)}.registry-binding-candidate.v1.json`);
  fs.writeFileSync(candidatePath, JSON.stringify(registryBindingCandidate(manifest, resolved.spec.deployment.registryRoots ?? [], resolved.spec.deployment.localOnly ?? false), null, 2) + '\n');
  console.log(`\n✅ Deployed ${results.length} contract(s); record written to ${recordPath}`);
  console.log(`   immutable manifest: ${manifestPath} (${manifestRoot})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
