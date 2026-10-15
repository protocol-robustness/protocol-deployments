import * as path from 'path';
import { loadConfig, loadEnvironment, loadRuntime } from './config/load';
import { createBundleConsumer } from './artifacts/bundle';
import { resolve } from './resolver';
import { computeSpecHash } from './spec-hash';
import { canonicalJson } from './canonical-json';
import { ConfigError } from './errors';
import type { ResolvedSpec } from './canonical';
import { assertNoPlaceholderRootBindings, readDeploymentUnitCatalog, readSuccessorDeploymentPlan, validatePlanAgainstUnits, projectConfigurationForPlan } from './deployment/successor-plan';
import { readStageOutputReceiptDirectory, stageOutputValuesForPlan, type StageOutputReceiptV1 } from './deployment/stage-output';
import { readCrossPlanStageOutputEvidenceDirectory, verifyCrossPlanStageOutput, type CrossPlanStageOutputEvidenceV1 } from './deployment/cross-plan-stage-output';

export interface ResolvedDeploymentOutput {
  spec: ResolvedSpec;
  specHash: string;
  canonicalJson: string;
  deploymentPlan?: import('./deployment/successor-plan').SuccessorDeploymentPlanV1;
  stageOutputReceipts?: Record<string, import('./deployment/stage-output').StageOutputReceiptV1>;
  crossPlanStageOutputEvidence?: Record<string, CrossPlanStageOutputEvidenceV1>;
}

/**
 * Full Phase 1 resolution pipeline:
 *   EDN config -> parse -> validate -> resolve -> canonical JSON + spec hash.
 * No transactions are performed.
 */
export function resolveDeployment(opts: {
  configDir: string;
  environment: string;
  fixtureRoot: string;
  profileDir?: string;
  nodeModulesDir?: string;
  /** Local development reads every source from fixtures (default true). */
  preferFixtures?: boolean;
  /** Require clean-git provenance for every loaded bundle. */
  requirePinnedProvenance?: boolean;
  /** Explicit executable deployment plan. Omitting it keeps legacy flat resolution. */
  deploymentPlanFile?: string;
  /** Immutable receipts produced by earlier stages of the same selected plan. */
  stageOutputReceiptsDir?: string;
  /** Retained producer plan, execution, manifest and live-observation evidence for cross-plan outputs. */
  crossPlanStageOutputEvidenceDir?: string;
}): ResolvedDeploymentOutput {
  let config = loadConfig({ configDir: opts.configDir, profileDir: opts.profileDir });
  let environment = loadEnvironment(opts.configDir, opts.environment, opts.profileDir);
  let deploymentPlan: import('./deployment/successor-plan').SuccessorDeploymentPlanV1 | undefined;
  let stageOutputReceipts: Record<string, StageOutputReceiptV1> | undefined;
  let crossPlanStageOutputEvidence: Record<string, CrossPlanStageOutputEvidenceV1> | undefined;
  if (opts.deploymentPlanFile) {
    const plan = readSuccessorDeploymentPlan(opts.deploymentPlanFile);
    deploymentPlan = plan;
    const catalog = readDeploymentUnitCatalog(path.join(opts.configDir, 'deployment-units.v1.json'));
    validatePlanAgainstUnits(plan, catalog);
    assertNoPlaceholderRootBindings(config, Object.keys(plan.contracts));
    const allowLocalFork = plan.localOnly && environment.chain.kind !== 'local'
      ? loadRuntime(opts.configDir, opts.environment).provider === 'anvil-fork'
      : false;
    if (opts.stageOutputReceiptsDir) stageOutputReceipts = readStageOutputReceiptDirectory(opts.stageOutputReceiptsDir);
    const hasCrossPlan = Object.values(plan.contracts).some((source) => source.kind === 'stage-output' && source.producer);
    if (opts.crossPlanStageOutputEvidenceDir) crossPlanStageOutputEvidence = readCrossPlanStageOutputEvidenceDirectory(opts.crossPlanStageOutputEvidenceDir);
    if (hasCrossPlan && !crossPlanStageOutputEvidence) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_REQUIRED', 'Cross-plan stage-output dependencies require --cross-plan-stage-output-evidence');
    const expectedEvidenceIds = Object.entries(plan.contracts).filter(([, source]) => source.kind === 'stage-output' && source.producer).map(([id]) => id).sort();
    if (crossPlanStageOutputEvidence && canonicalJson(Object.keys(crossPlanStageOutputEvidence).sort()) !== canonicalJson(expectedEvidenceIds)) {
      throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_SET', 'Cross-plan evidence set does not exactly match the selected plan dependencies');
    }
    const crossPlanValues: Record<string, unknown> = {};
    for (const [logicalId, source] of Object.entries(plan.contracts)) {
      if (source.kind !== 'stage-output' || !source.producer) continue;
      const evidence = crossPlanStageOutputEvidence?.[logicalId];
      if (!evidence) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_REQUIRED', `Pinned cross-plan producer evidence is missing for '${logicalId}'`);
      const verified = verifyCrossPlanStageOutput({ consumerPlan: plan, logicalId, evidence, expectedChainId: environment.chain.chainId });
      crossPlanValues[logicalId] = verified.value;
    }
    const stageOutputValues = stageOutputValuesForPlan(plan, stageOutputReceipts ?? {}, crossPlanValues);
    ({ config, environment } = projectConfigurationForPlan(config, environment, plan, { allowLocalFork, stageOutputValues }));
  }
  const bundle = createBundleConsumer({
    sources: config.architecture.artifactSources,
    fixtureRoot: opts.fixtureRoot,
    nodeModulesDir: opts.nodeModulesDir,
    preferFixtures: opts.preferFixtures,
    requirePinnedProvenance: opts.requirePinnedProvenance,
  });

  const spec = resolve(
    { config, environment, bundle },
    { environmentSource: environment.environment },
  );

  const canonical = canonicalJson(spec);
  const specHash = computeSpecHash(spec);

  return { spec, specHash, canonicalJson: canonical, deploymentPlan, stageOutputReceipts, crossPlanStageOutputEvidence };
}
