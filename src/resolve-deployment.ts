import { loadConfig, loadEnvironment } from './config/load';
import { BundleConsumer, FixtureBundleLocator } from './artifacts/bundle';
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
}): ResolvedDeploymentOutput {
  const config = loadConfig({ configDir: opts.configDir });
  const environment = loadEnvironment(opts.configDir, opts.environment);
  const bundle = new BundleConsumer(new FixtureBundleLocator(opts.fixtureRoot));

  const spec = resolve(
    { config, environment, bundle },
    { environmentSource: environment.environment },
  );

  const canonical = canonicalJson(spec);
  const specHash = computeSpecHash(spec);

  return { spec, specHash, canonicalJson: canonical };
}
