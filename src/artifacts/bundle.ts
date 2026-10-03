import * as fs from 'fs';
import * as path from 'path';
import { ConfigError } from '../errors';
import {
  sha256Hex,
  sha256HexOfBuffer,
  normalizeBytecode,
  normalizeHex,
  isBytecode,
  bytecodeHash,
} from './hash';
import { canonicalJson } from '../canonical-json';
import {
  deployableManifestSchema,
  deployableArtifactSchema,
  type DeployableManifest,
  type DeployableArtifact,
  type LoadedArtifact,
  type ArtifactEntry,
  type ResolvedArtifact,
} from './types';

/**
 * Maps an artifact-source id to a directory containing a deployable bundle
 * (a manifest.json plus an artifacts/ folder) as emitted by the SEW/PRF
 * exporters. Phase 2 resolves these from local fixture copies or packed
 * packages; production uses an immutable pinned package identity.
 */
export interface BundleLocator {
  resolve(sourceId: string, pkg: string): string;
}

export class FixtureBundleLocator implements BundleLocator {
  constructor(private readonly fixtureRoot: string) {}

  resolve(_sourceId: string, pkg: string): string {
    // pkg may be scoped like "@sew/deployables" -> fixtureRoot/@sew/deployables
    return path.join(this.fixtureRoot, ...pkg.split('/'));
  }
}

/** Loads and validates a deployable bundle in the SEW/PRF exporter format. */
export class BundleConsumer {
  constructor(private readonly locator: BundleLocator) {}

  private manifestDir(sourceId: string, pkg: string): string {
    const dir = this.locator.resolve(sourceId, pkg);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      throw new ConfigError(
        'ARTIFACT_SOURCE_NOT_FOUND',
        `No deployable bundle found for source '${sourceId}' at ${dir}`,
        { path: dir },
      );
    }
    return dir;
  }

  /** Load, validate, and verify the bundle root for a source. */
  loadManifest(sourceId: string, pkg: string, version: string): DeployableManifest {
    const dir = this.manifestDir(sourceId, pkg);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch (e) {
      throw new ConfigError(
        'ARTIFACT_MANIFEST_INVALID',
        `Invalid manifest for source '${sourceId}': ${e instanceof Error ? e.message : String(e)}`,
        { path: path.join(dir, 'manifest.json') },
      );
    }
    const parsed = deployableManifestSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(
        'ARTIFACT_MANIFEST_SCHEMA',
        `Manifest for source '${sourceId}' failed schema validation`,
        { path: path.join(dir, 'manifest.json'), details: { issues: parsed.error.issues } },
      );
    }
    if (parsed.data.packageName !== pkg || parsed.data.bundleVersion !== version) {
      throw new ConfigError(
        'ARTIFACT_SOURCE_MISMATCH',
        `Bundle for source '${sourceId}' is ${parsed.data.packageName}@${parsed.data.bundleVersion}, expected ${pkg}@${version}`,
      );
    }
    // Verify bundle-level integrity root.
    const { bundleRoot, ...rest } = parsed.data as DeployableManifest & { bundleRoot: string };
    const recomputed = sha256Hex(canonicalJson(rest));
    if (recomputed !== normalizeHex(bundleRoot)) {
      throw new ConfigError(
        'BUNDLE_ROOT_MISMATCH',
        `Bundle root mismatch for source '${sourceId}': expected ${bundleRoot}, got ${recomputed}`,
      );
    }
    return parsed.data;
  }

  /**
   * Load a single artifact by name from a source, validating manifest entry,
   * file hash, and component hashes. Returns the artifact and its file hash.
   */
  loadArtifact(
    sourceId: string,
    pkg: string,
    version: string,
    artifactName: string,
  ): LoadedArtifact {
    const manifest = this.loadManifest(sourceId, pkg, version);
    const entry: ArtifactEntry | undefined = manifest.artifacts[artifactName];
    if (!entry) {
      throw new ConfigError(
        'ARTIFACT_MISSING',
        `Artifact '${artifactName}' not present in source '${sourceId}' (${pkg}@${version})`,
        { details: { available: Object.keys(manifest.artifacts) } },
      );
    }

    const dir = this.manifestDir(sourceId, pkg);
    const filePath = path.join(dir, entry.artifactFile);
    let raw: unknown;
    let fileSha: string;
    try {
      const buf = fs.readFileSync(filePath);
      fileSha = sha256HexOfBuffer(buf);
      if (fileSha !== entry.fileSha256) {
        throw new ConfigError(
          'ARTIFACT_HASH_MISMATCH',
          `Artifact file hash mismatch for '${artifactName}' (${sourceId}): expected ${entry.fileSha256}, got ${fileSha}`,
          { path: filePath },
        );
      }
      raw = JSON.parse(buf.toString('utf8'));
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(
        'ARTIFACT_UNREADABLE',
        `Cannot read artifact '${artifactName}': ${e instanceof Error ? e.message : String(e)}`,
        { path: filePath },
      );
    }

    const parsed = deployableArtifactSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(
        'ARTIFACT_SCHEMA',
        `Artifact '${artifactName}' (${sourceId}) failed schema validation`,
        { path: filePath, details: { issues: parsed.error.issues } },
      );
    }
    const a = parsed.data;
    if (a.name !== artifactName) {
      throw new ConfigError(
        'ARTIFACT_NAME_MISMATCH',
        `Artifact file name '${a.name}' does not match requested '${artifactName}'`,
        { path: filePath },
      );
    }

    // Validate bytecode/abi integrity against manifest hashes.
    if (!isBytecode(a.bytecode) || !isBytecode(a.deployedBytecode)) {
      throw new ConfigError('ARTIFACT_BYTECODE_INVALID', `Bytecode of '${artifactName}' is invalid/missing`);
    }

    const abiSha = sha256Hex(canonicalJson(a.abi));
    const creationSha = bytecodeHash(a.bytecode);
    const runtimeSha = bytecodeHash(a.deployedBytecode);
    for (const [label, computed, expected] of [
      ['abi', abiSha, entry.abiSha256],
      ['creationBytecode', creationSha, entry.creationBytecodeSha256],
      ['runtimeBytecode', runtimeSha, entry.runtimeBytecodeSha256],
    ] as const) {
      if (computed !== normalizeBytecode(expected)) {
        throw new ConfigError(
          'ARTIFACT_HASH_MISMATCH',
          `${label} hash mismatch for '${artifactName}' (${sourceId})`,
        );
      }
    }

    return { artifact: a, fileSha256: fileSha };
  }

  /**
   * Produce a ResolvedArtifact binding a logical contract to a concrete
   * validated artifact from a pinned source.
   */
  bindArtifact(
    sourceId: string,
    pkg: string,
    version: string,
    artifactName: string,
  ): ResolvedArtifact {
    const manifest = this.loadManifest(sourceId, pkg, version);
    const entry = manifest.artifacts[artifactName];
    if (!entry) {
      throw new ConfigError('ARTIFACT_MISSING', `Artifact '${artifactName}' not present in source '${sourceId}'`);
    }
    const loaded = this.loadArtifact(sourceId, pkg, version, artifactName);
    return {
      source: sourceId,
      package: pkg,
      version,
      sourceRepo: manifest.source.repository,
      sourceCommit: manifest.source.commit,
      artifactName,
      artifactPath: entry.artifactFile,
      fileSha256: loaded.fileSha256,
      abiSha256: entry.abiSha256,
      creationBytecodeSha256: entry.creationBytecodeSha256,
      deployedBytecodeSha256: entry.runtimeBytecodeSha256,
      compiler: { name: manifest.build.compiler.name, version: manifest.build.compiler.version },
      abi: loaded.artifact.abi,
      verifier: entry.verifier
        ? { family: entry.verifier.family, configMechanism: entry.verifier.configMechanism }
        : undefined,
    };
  }
}
