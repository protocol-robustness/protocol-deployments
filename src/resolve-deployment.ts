import * as path from 'path';
import { loadConfig, loadEnvironment, loadRuntime } from './config/load';
import { createBundleConsumer } from './artifacts/bundle';
import { resolve } from './resolver';
import { computeSpecHash } from './spec-hash';
import { canonicalJson } from './canonical-json';
import type { ResolvedSpec } from './canonical';
import { assertNoPlaceholderRootBindings, readDeploymentUnitCatalog, readSuccessorDeploymentPlan, validatePlanAgainstUnits, projectConfigurationForPlan } from './deployment/successor-plan';

export interface ResolvedDeploymentOutput {
  spec: ResolvedSpec;
  specHash: string;
  canonicalJson: string;
  deploymentPlan?: import('./deployment/successor-plan').SuccessorDeploymentPlanV1;
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
}): ResolvedDeploymentOutput {
  let config = loadConfig({ configDir: opts.configDir, profileDir: opts.profileDir });
  let environment = loadEnvironment(opts.configDir, opts.environment, opts.profileDir);
  let deploymentPlan: import('./deployment/successor-plan').SuccessorDeploymentPlanV1 | undefined;
  if (opts.deploymentPlanFile) {
    const plan = readSuccessorDeploymentPlan(opts.deploymentPlanFile);
    deploymentPlan = plan;
    const catalog = readDeploymentUnitCatalog(path.join(opts.configDir, 'deployment-units.v1.json'));
    validatePlanAgainstUnits(plan, catalog);
    assertNoPlaceholderRootBindings(config, Object.keys(plan.contracts));
    const allowLocalFork = plan.localOnly && environment.chain.kind !== 'local'
      ? loadRuntime(opts.configDir, opts.environment).provider === 'anvil-fork'
      : false;
    ({ config, environment } = projectConfigurationForPlan(config, environment, plan, { allowLocalFork }));
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

  return { spec, specHash, canonicalJson: canonical, deploymentPlan };
}
