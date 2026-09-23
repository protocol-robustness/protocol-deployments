import { z } from 'zod';

/**
 * Raw EDN input shapes. These schemas describe exactly what may appear in
 * the `config/*.edn` files. They are intentionally strict and small. The
 * canonical *resolved* representation (see ../canonical.ts) is a separate,
 * fully explicit object — it is never the same type as these raw inputs.
 *
 * All bigint values in EDN must use the `N` suffix (e.g. `1000000000000000000N`)
 * so that exact wei amounts are not lost to floating point.
 */

export const scopeSchema = z.enum(['prf', 'sew', 'shared']);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export const parameterConstraintSchema = z.union([
  z.object({ range: z.tuple([z.bigint(), z.bigint()]) }),
  z.object({ oneOf: z.array(z.bigint()) }),
]);

export const parameterSchema = z
  .object({
    value: z.union([z.bigint(), z.string(), z.number(), z.boolean()]),
    mutability: z.enum(['immutable', 'governed']).default('immutable'),
    constraint: parameterConstraintSchema.optional(),
  })
  .strict();

export const parameterMapSchema = z.record(z.string(), parameterSchema);

/** A deliberately closed constructor-value vocabulary; never arbitrary expressions. */
export type RawBinding =
  | { literal: string | number | boolean | bigint }
  | { parameter: string }
  | { contractAddress: string }
  | { runtimeCodeHash: string }
  | { deployer: true }
  | { externalAddress: string }
  | { array: RawBinding[] };

export const bindingSchema: z.ZodType<RawBinding> = z.lazy(() =>
  z.union([
    z.object({ literal: z.union([z.string(), z.number(), z.boolean(), z.bigint()]) }).strict(),
    z.object({ parameter: z.string().min(1) }).strict(),
    z.object({ contractAddress: z.string().min(1) }).strict(),
    z.object({ runtimeCodeHash: z.string().min(1) }).strict(),
    z.object({ deployer: z.literal(true) }).strict(),
    z.object({ externalAddress: z.string().min(1) }).strict(),
    z.object({ array: z.array(bindingSchema) }).strict(),
  ]),
);
export const constructorBindingMapSchema = z.record(z.string(), bindingSchema);

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

export const artifactSourceSchema = z
  .object({
    package: z.string().min(1),
    version: z.string().min(1),
    sourceRepo: z.string().min(1),
    kind: z.enum(['npm', 'fixture']).default('npm'),
  })
  .strict();

export const artifactSourceMapSchema = z.record(
  z.string(), // e.g. "sew/deployables"
  artifactSourceSchema,
);

/** Small, explicit relationship vocabulary. Not a general ontology. */
export const RELATIONSHIP_KEYS = [
  'dependsOn',
  'uses',
  'registeredIn',
  'administeredBy',
  'guardedBy',
  'provides',
] as const;
export type RelationshipKey = (typeof RELATIONSHIP_KEYS)[number];

export const relationshipMapSchema = z.record(
  z.enum(RELATIONSHIP_KEYS),
  z.array(z.string()), // logical contract ids
);

export const logicalContractSchema = z
  .object({
    scope: scopeSchema,
    artifactSource: z.string(),
    artifact: z.string(),
    parameters: parameterMapSchema.optional(),
    /** ABI input name -> a typed, declarative constructor binding. */
    constructorBindings: constructorBindingMapSchema.optional(),
    relationships: relationshipMapSchema.optional(),
  })
  .strict();

export const architectureSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    artifactSources: artifactSourceMapSchema,
    contracts: z.record(z.string(), logicalContractSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export const governorSchema = z
  .object({
    contract: z.string(), // logical contract id of the governor
    token: z.string(), // logical contract id of the voting token
    quorum: z.bigint().optional(),
    proposalThreshold: z.bigint().optional(),
  })
  .strict();

export const governorMapSchema = z.record(z.string(), governorSchema);

export const laneSchema = z
  .object({
    governor: z.string(), // governor id
    timelock: z.string(), // logical contract id of the timelock
  })
  .strict();

export const laneMapSchema = z.record(z.string(), laneSchema);

export const governedOperationSchema = z
  .object({
    target: z.string(), // logical contract id
    parameter: z.string(), // parameter name on the target contract
  })
  .strict();

export const governanceGroupSchema = z
  .object({
    lane: z.string(), // execution lane id
    operations: z.record(z.string(), governedOperationSchema),
  })
  .strict();

export const governanceGroupMapSchema = z.record(z.string(), governanceGroupSchema);

export const governanceSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    tokens: z.record(z.string(), z.object({ contract: z.string() }).strict()),
    governors: governorMapSchema,
    lanes: laneMapSchema,
    groups: governanceGroupMapSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export const verificationApplicationSchema = z
  .object({
    verificationProfile: z.string(),
  })
  .strict();

export const verificationProfileSchema = z
  .object({
    verifierImplementation: z.string(),
    programId: z.string().optional(),
    vkHash: z.string().optional(),
    statement: z.string().optional(),
  })
  .strict();

export const verifierImplementationSchema = z
  .object({
    contract: z.string(), // logical contract id of the verifier
  })
  .strict();

export const verificationSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    applications: z.record(z.string(), verificationApplicationSchema),
    verificationProfiles: z.record(z.string(), verificationProfileSchema),
    verifierImplementations: z.record(z.string(), verifierImplementationSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Environment (chain identity only — NOT runtime/provider)
// ---------------------------------------------------------------------------

export const bootstrapActionSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  function: z.string().min(1),
  args: z.array(bindingSchema).default([]),
}).strict();

export const bootstrapAssertionSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  function: z.string().min(1),
  args: z.array(bindingSchema).default([]),
  /** Literal expected value retained for simple scalar assertions. */
  expected: z.union([z.string(), z.number(), z.boolean(), z.bigint()]).optional(),
  /** Typed expected value for topology assertions such as contract-address equality. */
  expectedBinding: bindingSchema.optional(),
}).strict().refine(
  (assertion) => (assertion.expected === undefined) !== (assertion.expectedBinding === undefined),
  { message: 'Bootstrap assertion requires exactly one of expected or expectedBinding' },
);

export const chainBindingSchema = z
  .object({
    logicalRole: z.string(), // e.g. "local", "testnet", "mainnet"
    chainId: z.number().int(),
    kind: z.enum(['local', 'testnet', 'mainnet']).optional(), // chain kind (not runtime)
  })
  .strict();

export const environmentSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    environment: z.string(),
    chain: chainBindingSchema,
    overlays: z
      .record(
        z.string(), // logical contract id
        z
          .object({
            parameters: z.record(
              z.string(),
              z.object({ value: z.union([z.bigint(), z.string(), z.number(), z.boolean()]) }).strict(),
            ),
          })
          .strict(),
      )
      .optional(),
    deploymentOrder: z.array(z.string()), // explicit order of logical contract ids
    /** Explicit application roots eligible for registry handoff; does not imply admission. */
    registryRoots: z.array(z.string()).default([]),
    /** Marks generated registry candidates as non-production synthetic output. */
    localOnly: z.boolean().default(false),
    /** Named addresses supplied by the environment, such as a canonical token. */
    externalAddresses: z.record(z.string(), z.string()).optional(),
    /** Constrained initial wiring only; not a general lifecycle/workflow language. */
    bootstrapActions: z.array(bootstrapActionSchema).default([]),
    bootstrapAssertions: z.array(bootstrapAssertionSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Runtime (how the target chain is provided) — separate from environment.
// Carries no secrets inline; endpoints/keys are resolved from env var names.
// ---------------------------------------------------------------------------

export const runtimeSchema = z
  .object({
    schemaVersion: z.number().int().default(1),
    provider: z.enum(['anvil', 'anvil-fork', 'external']),
    // anvil / anvil-fork
    rpcUrl: z.string().optional(),
    port: z.number().int().optional(),
    stateInterval: z.number().int().positive().optional(),
    // external
    rpcUrlEnv: z.string().optional(),
    // anvil-fork
    sourceRpcEnv: z.string().optional(),
    forkBlock: z.number().int().optional(),
    // signer
    signer: z
      .object({
        type: z.enum(['private-key-env', 'deterministic-local', 'unlocked']),
        env: z.string().optional(), // env var holding the private key (hex, no 0x)
      })
      .strict(),
  })
  .strict();

export type RawArchitecture = z.infer<typeof architectureSchema>;
export type RawGovernance = z.infer<typeof governanceSchema>;
export type RawVerification = z.infer<typeof verificationSchema>;
export type RawEnvironment = z.infer<typeof environmentSchema>;
export type RawRuntime = z.infer<typeof runtimeSchema>;
export type RawParameter = z.infer<typeof parameterSchema>;
export type RawLogicalContract = z.infer<typeof logicalContractSchema>;
export type RawArtifactSource = z.infer<typeof artifactSourceSchema>;
export type RawChainBinding = z.infer<typeof chainBindingSchema>;
