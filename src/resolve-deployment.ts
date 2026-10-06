import { loadConfig, loadEnvironment } from './config/load';
import { createBundleConsumer } from './artifacts/bundle';
import { resolve } from './resolver';
import { computeSpecHash } from './spec-hash';
import { canonicalJson } from './canonical-json';
import type { ResolvedSpec } from './canonical';

export interface ResolvedDeploymentOutput {
  spec: ResolvedSpec;
  specHash: string;
  canonicalJson: string;
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
}): ResolvedDeploymentOutput {
  const config = loadConfig({ configDir: opts.configDir, profileDir: opts.profileDir });
  const environment = loadEnvironment(opts.configDir, opts.environment, opts.profileDir);
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

  return { spec, specHash, canonicalJson: canonical };
}
