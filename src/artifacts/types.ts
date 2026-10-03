import { z } from 'zod';

/**
 * The deployable artifact contract — i.e. the format emitted by the SEW and
 * PRF deployable-artifact exporters (`deployables/manifest.json` + per-artifact
 * files). This repository NEVER compiles Solidity source; it consumes these
 * immutable, versioned bundles.
 */

export const verifierMetaSchema = z
  .object({
    family: z.string(),
    configMechanism: z.string(),
    registryInterface: z.string().optional(),
    admissionInterface: z.string().optional(),
  })
  .optional();

export const manifestArtifactEntrySchema = z
  .object({
    contractName: z.string(),
    sourcePath: z.string(),
    origin: z.string().optional(),
    scopeHint: z.enum(['sew', 'shared', 'prf']).optional(),
    category: z.string().optional(),
    verifier: verifierMetaSchema,
    artifactFile: z.string(), // path within the package to the artifact file
    abiSha256: z.string(),
    creationBytecodeSha256: z.string(),
    runtimeBytecodeSha256: z.string(),
    constructorAbiSha256: z.string().optional(),
    fileSha256: z.string(),
    hasLinkReferences: z.boolean(),
    hasDeployedLinkReferences: z.boolean(),
  })
  .strict();

export const deployableManifestSchema = z
  .object({
    schemaVersion: z.number(),
    packageName: z.string(),
    bundleVersion: z.string(),
    source: z
      .object({
        repository: z.string(),
        commit: z.string(),
        commitSource: z.string(),
        commitOverride: z.boolean(),
        dirty: z.boolean(),
      })
      .strict(),
    build: z
      .object({
        artifactSource: z.string(),
        profile: z.string(),
        compiler: z.object({ name: z.string(), version: z.string() }),
        settings: z
          .object({
            evmVersion: z.string(),
            optimizerRuns: z.number(),
            viaIR: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    artifacts: z.record(z.string(), manifestArtifactEntrySchema),
    bundleRoot: z.string(),
  })
  .strict();

export const deployableArtifactSchema = z
  .object({
    name: z.string(),
    contractName: z.string(),
    sourcePath: z.string(),
    origin: z.string().optional(),
    scopeHint: z.enum(['sew', 'shared', 'prf']).optional(),
    category: z.string().optional(),
    verifier: verifierMetaSchema,
    abi: z.array(z.unknown()),
    bytecode: z.string(), // creation bytecode (0x...)
    deployedBytecode: z.string(), // runtime bytecode (0x...)
    linkReferences: z.record(z.string(), z.record(z.string(), z.array(z.object({ start: z.number(), length: z.number() })))).optional(),
    deployedLinkReferences: z.record(z.string(), z.record(z.string(), z.array(z.object({ start: z.number(), length: z.number() })))).optional(),
    immutableReferences: z.record(z.string(), z.array(z.object({ start: z.number(), length: z.number() }))).optional(),
    metadata: z.string().optional(), // solc metadata blob
  })
  .strict();

export type DeployableManifest = z.infer<typeof deployableManifestSchema>;
export type DeployableArtifact = z.infer<typeof deployableArtifactSchema>;
export type ArtifactEntry = z.infer<typeof manifestArtifactEntrySchema>;

/**
 * A fully bound, validated artifact for a single logical contract.
 * Provenance + integrity + component hashes are all explicit.
 */
export interface ResolvedArtifact {
  source: string; // artifact source id (e.g. "sew/deployables")
  package: string;
  version: string;
  sourceRepo: string;
  sourceCommit: string;
  artifactName: string;
  artifactPath: string;
  fileSha256: string;
  abiSha256: string;
  creationBytecodeSha256: string;
  deployedBytecodeSha256: string; // = manifest runtimeBytecodeSha256
  compiler?: { name: string; version: string };
  /** Full ABI retained in the resolved spec for consumer convenience. */
  abi: unknown[];
  /** Manifest-provided verifier implementation metadata (PRF verifier adapters). */
  verifier?: { family: string; configMechanism: string };
  /** Full spec hash is derived from canonical JSON, not from these fields alone. */
}

/** Loaded raw artifact file plus its file hash. */
export interface LoadedArtifact {
  artifact: DeployableArtifact;
  fileSha256: string;
}
