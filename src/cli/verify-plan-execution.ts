#!/usr/bin/env ts-node
import * as fs from 'fs';
import { z } from 'zod';
import { readSuccessorDeploymentPlan } from '../deployment/successor-plan';
import { assertManifestVerified, computeManifestRoot } from '../deployment/manifest';
import { assertPlanExecutionMatchesManifest } from '../deployment/plan-execution';
import type { DeploymentManifest } from '../deployment/manifest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function read(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(): void {
  const planFile = arg('plan');
  const manifestFile = arg('manifest');
  const receiptFile = arg('receipt');
  if (!planFile || !manifestFile || !receiptFile) {
    throw new Error('Usage: verify-plan-execution.ts --plan <plan.json> --manifest <manifest.json> --receipt <plan-execution.json>');
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
  console.log(`Plan execution evidence verified`);
  console.log(`  plan: ${plan.planId}`);
  console.log(`  deployments: ${manifest.contracts.length}`);
  console.log(`  manifest root: ${computeManifestRoot(manifest)}`);
  console.log(`  execution root: ${receipt.planExecutionRoot}`);
  console.log(`  stage statuses include pending/non-executed entries where the deployment CLI does not implement protocol configuration or claims`);
}

main();
