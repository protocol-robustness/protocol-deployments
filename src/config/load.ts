import * as path from 'path';
import { z } from 'zod';
import { readEdnFile } from './edn';
import { ConfigError } from '../errors';
import {
  architectureSchema,
  governanceSchema,
  verificationSchema,
  environmentSchema,
  runtimeSchema,
  type RawArchitecture,
  type RawGovernance,
  type RawVerification,
  type RawEnvironment,
  type RawRuntime,
} from './raw-types';

export interface ConfigPaths {
  configDir: string;
  architecture?: string;
  governance?: string;
  verification?: string;
}

function parseWith<T extends z.ZodTypeAny>(schema: T, value: unknown, label: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ConfigError(
      'CONFIG_SCHEMA',
      `Config file '${label}' failed schema validation`,
      { details: { issues: r.error.issues } },
    );
  }
  return r.data;
}

export interface LoadedConfig {
  architecture: RawArchitecture;
  governance: RawGovernance;
  verification: RawVerification;
}

/** Load the three core config files (architecture, governance, verification). */
export function loadConfig(cfg: ConfigPaths): LoadedConfig {
  const defaults = {
    architecture: 'architecture.edn',
    governance: 'governance.edn',
    verification: 'verification.edn',
  };
  const join = (f: string) => path.join(cfg.configDir, f);

  const architecture = parseWith(
    architectureSchema,
    readEdnFile(cfg.architecture ?? join(defaults.architecture)),
    cfg.architecture ?? defaults.architecture,
  ) as RawArchitecture;

  const governance = parseWith(
    governanceSchema,
    readEdnFile(cfg.governance ?? join(defaults.governance)),
    cfg.governance ?? defaults.governance,
  ) as RawGovernance;

  const verification = parseWith(
    verificationSchema,
    readEdnFile(cfg.verification ?? join(defaults.verification)),
    cfg.verification ?? defaults.verification,
  ) as RawVerification;

  return { architecture, governance, verification };
}

/**
 * Load a single environment overlay file.
 *
 * The environment describes chain identity only. A legacy `:network` key is
 * rejected with an explicit migration error pointing to the new runtime layer.
 */
export function loadEnvironment(
  configDir: string,
  environmentName: string,
): RawEnvironment {
  const p = path.join(configDir, 'environments', `${environmentName}.edn`);
  const raw = readEdnFile(p) as Record<string, unknown>;
  const chain = raw.chain as Record<string, unknown> | undefined;
  if (chain && typeof chain === 'object' && 'network' in chain) {
    throw new ConfigError(
      'ENV_SCHEMA_MIGRATION',
      `Environment '${environmentName}' uses the removed ':chain/:network' key. ` +
        `Chain identity is now ':chain {:logicalRole .. :chainId .. :kind ..}'. ` +
        `Move the runtime/provider (e.g. anvil) into runtime/${environmentName}.edn.`,
      { path: p },
    );
  }
  return parseWith(
    environmentSchema,
    raw,
    path.basename(p),
  ) as RawEnvironment;
}

/**
 * Load the runtime configuration for an environment (how the target chain is
 * provided). Lives at runtime/<env>.edn, separate from the environment EDN.
 */
export function loadRuntime(configDir: string, environmentName: string): RawRuntime {
  const p = path.join(configDir, '..', 'runtime', `${environmentName}.edn`);
  return parseWith(runtimeSchema, readEdnFile(p), path.basename(p)) as RawRuntime;
}
