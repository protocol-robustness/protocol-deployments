import * as path from 'path';
import type { z } from 'zod';
import { parseEdn } from '../src/config/edn';
import {
  architectureSchema,
  governanceSchema,
  verificationSchema,
  environmentSchema,
  type RawArchitecture,
  type RawGovernance,
  type RawVerification,
  type RawEnvironment,
} from '../src/config/raw-types';
import { resolve } from '../src/resolver';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';
import { ConfigError } from '../src/errors';
import { computeSpecHash } from '../src/spec-hash';
import { canonicalJson } from '../src/canonical-json';
import type { ResolvedSpec } from '../src/canonical';

export const CONFIG_DIR = path.resolve(__dirname, '..', 'config');
export const FIXTURE_ROOT = path.resolve(__dirname, '..', 'fixtures', 'packages');

export function bundle(): BundleConsumer {
  return new BundleConsumer(new FixtureBundleLocator(FIXTURE_ROOT));
}

export interface EdnInputs {
  architecture: string;
  governance: string;
  verification: string;
  environment: string;
}

export const baseline: EdnInputs = {
  architecture: `
{:schemaVersion 1
 :artifactSources
 { :sew/deployables {:package "@sew/deployables" :version "0.1.0" :sourceRepo "sew/sew-protocol" :kind :npm}
   :prf/deployables {:package "@protocol-robustness/prf-evm-deployables" :version "0.2.0" :sourceRepo "protocol-robustness/prf-evm" :kind :npm} }
  :contracts
  { :shared/gov-token {:scope :shared :artifactSource :sew/deployables :artifact "SewToken"
                        :parameters {:name {:value "G" :mutability :immutable}
                                     :supply {:value 100N :mutability :immutable}}}
    :shared/timelock {:scope :shared :artifactSource :sew/deployables :artifact "TimelockController"
                       :parameters {:minDelay {:value 10 :mutability :immutable}}}
    :shared/governor {:scope :shared :artifactSource :sew/deployables :artifact "GovGovernor"
                       :relationships {:dependsOn [:shared/timelock]}
                       :parameters {:quorum {:value 50N :mutability :governed :constraint {:range [0N 100N]}}}}
    :sew/escrow {:scope :sew :artifactSource :sew/deployables :artifact "EscrowVault"
                  :parameters {:rate {:value 500N :mutability :governed :constraint {:range [0N 2000N]}}}}
    :prf/verifier {:scope :prf :artifactSource :prf/deployables :artifact "PrfVerifierRegistry"
                    :parameters {:version {:value "1" :mutability :immutable}}} } }`,
  governance: `
{:schemaVersion 1
 :tokens { :sew/token {:contract :shared/gov-token} }
 :governors { :sew/governor {:contract :shared/governor :token :sew/token} }
 :lanes { :sew/lane {:governor :sew/governor :timelock :shared/timelock} }
 :groups
 { :sew/econ {:lane :sew/lane
              :operations { :escrow/rate {:target :sew/escrow :parameter :rate} }}
   :shared/dep {:lane :sew/lane
                :operations { :gov/quorum {:target :shared/governor :parameter :quorum} }} } }`,
  verification: `
{:schemaVersion 1
 :applications { :sew/app {:verificationProfile :prf/profile} }
 :verificationProfiles { :prf/profile {:verifierImplementation :prf/impl :programId "p" :vkHash "0x"} }
 :verifierImplementations { :prf/impl {:contract :prf/verifier} } }`,
  environment: `
{:schemaVersion 1 :environment :test
 :chain {:logicalRole :local :chainId 31337}
 :deploymentOrder [ :shared/gov-token :shared/timelock :shared/governor :sew/escrow :prf/verifier ] }`,
};

function parseSchema<T extends z.ZodTypeAny>(schema: T, text: string, name: string): z.infer<T> {
  const parsed = parseEdn(text, name);
  const r = schema.safeParse(parsed);
  if (!r.success) {
    throw new ConfigError('CONFIG_SCHEMA', `Test EDN '${name}' invalid: ${JSON.stringify(r.error.issues)}`);
  }
  return r.data;
}

export interface ResolveResult {
  architecture: RawArchitecture;
  governance: RawGovernance;
  verification: RawVerification;
  environment: RawEnvironment;
  spec: ResolvedSpec;
  specHash: string;
  canonicalJson: string;
}

/** Parse + validate + resolve from raw EDN strings. Throws ConfigError on any failure. */
export function resolveEdn(inputs: Partial<EdnInputs> = {}): ResolveResult {
  const arch = inputs.architecture ?? baseline.architecture;
  const gov = inputs.governance ?? baseline.governance;
  const ver = inputs.verification ?? baseline.verification;
  const env = inputs.environment ?? baseline.environment;

  const architecture = parseSchema(architectureSchema, arch, 'architecture.edn');
  const governance = parseSchema(governanceSchema, gov, 'governance.edn');
  const verification = parseSchema(verificationSchema, ver, 'verification.edn');
  const environment = parseSchema(environmentSchema, env, 'environment.edn');

  const spec = resolve(
    { config: { architecture, governance, verification }, environment, bundle: bundle() },
    { environmentSource: 'test' },
  );
  const cj = canonicalJson(spec);
  return {
    architecture,
    governance,
    verification,
    environment,
    spec,
    specHash: computeSpecHash(spec),
    canonicalJson: cj,
  };
}

/** Assert that resolving `inputs` throws a ConfigError with the given code. */
export function expectCode(inputs: Partial<EdnInputs>, code: string): void {
  try {
    resolveEdn(inputs);
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`Expected ConfigError code '${code}' but got: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`Expected ConfigError code '${code}' but resolution succeeded`);
}
