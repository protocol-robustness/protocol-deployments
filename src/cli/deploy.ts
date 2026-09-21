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
import { resolveDeployment } from '../resolve-deployment';
import { loadRuntime } from '../config/load';
import { BundleConsumer, FixtureBundleLocator } from '../artifacts/bundle';
import { bindRuntime } from '../runtime/bind';
import { deployContract, type DeployContractResult } from '../deployment/engine';
import { emptyRecord, saveRecord, recordPathFor, artifactIdentityOf, type DeploymentRecord } from '../deployment/record';

async function main(): Promise<void> {
  const environment = process.argv[2];
  if (!environment) {
    console.error('Usage: deploy.ts <environment>');
    process.exit(2);
  }
  const configDir = path.resolve(process.cwd(), 'config');
  const fixtureRoot = path.resolve(process.cwd(), 'fixtures', 'packages');
  const deploymentsDir = path.resolve(process.cwd(), 'deployments');

  const resolved = resolveDeployment({ configDir, environment, fixtureRoot });
  const runtime = loadRuntime(configDir, environment);
  const bound = await bindRuntime(runtime, environment, configDir);

  try {
    await run(resolved, bound, environment, configDir, fixtureRoot, deploymentsDir);
  } finally {
    if (bound.anvil) await bound.anvil.stop().catch(() => {});
  }
}

async function run(
  resolved: Awaited<ReturnType<typeof resolveDeployment>>,
  bound: Awaited<ReturnType<typeof bindRuntime>>,
  environment: string,
  configDir: string,
  fixtureRoot: string,
  deploymentsDir: string,
): Promise<void> {
  const chainId = await bound.transport.getChainId();
  if (chainId !== resolved.spec.chain.chainId) {
    throw new Error(`Configured chain id ${resolved.spec.chain.chainId} differs from connected ${chainId}`);
  }
  const deployer = await bound.signer.getAddress();
  const bundle = new BundleConsumer(new FixtureBundleLocator(fixtureRoot));

  const record: DeploymentRecord = emptyRecord({
    specHash: resolved.specHash,
    environment,
    chainId: resolved.spec.chain.chainId,
  });
  record.deployer = deployer;

  const results: DeployContractResult[] = [];
  for (const step of resolved.spec.deployment.steps) {
    const res = await deployContract({
      spec: resolved.spec,
      logicalId: step.logicalId,
      bundle,
      transport: bound.transport,
      signer: bound.signer,
    });
    results.push(res);
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

  record.status = 'complete';
  record.blockNumber = (await bound.transport.getBlockNumber()).toString();
  record.deployedAt = new Date().toISOString();
  saveRecord(recordPathFor(deploymentsDir, environment), record);
  console.log(`\n✅ Deployed ${results.length} contract(s); record written to ${recordPathFor(deploymentsDir, environment)}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
