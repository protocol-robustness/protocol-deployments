import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { BundleConsumer, FixtureBundleLocator, NpmBundleLocator, SourceMapBundleLocator, createBundleConsumer } from '../src/artifacts/bundle';
import { ConfigError } from '../src/errors';
import { canonicalJson } from '../src/canonical-json';

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
function shaStr(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function bcHash(bytecode: string): string {
  return shaStr(bytecode.replace(/^0x/, '').toLowerCase());
}

interface Overrides {
  fileBytecode?: string;
  manifestBytecodeHash?: string;
  version?: string;
  artifactFile?: string;
  artifactOverride?: Record<string, unknown>;
  source?: { repository: string; commit: string; commitSource: string; commitOverride: boolean; dirty: boolean };
}

function expectBundleCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

describe('BundleConsumer (Phase 2 boundary, exercised on exporter-format bundles)', () => {
  let root: string;
  let consumer: BundleConsumer;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
    const pkgDir = path.join(root, '@test', 'pkg');
    fs.mkdirSync(path.join(pkgDir, 'artifacts'), { recursive: true });
    consumer = new BundleConsumer(new FixtureBundleLocator(root));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function manifestPath(): string {
    return path.join(root, '@test', 'pkg', 'manifest.json');
  }

  function readManifest(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as Record<string, unknown>;
  }

  /** Rewrite the manifest with a freshly recomputed (or deliberately wrong) root. */
  function rewriteManifest(mutate: (data: Record<string, unknown>) => void, rootValue?: string): void {
    const data = readManifest();
    const { bundleRoot, ...rest } = data;
    mutate(rest);
    fs.writeFileSync(manifestPath(), JSON.stringify({ ...rest, bundleRoot: rootValue ?? shaStr(canonicalJson(rest)) }));
  }

  function writeBundle(overrides: Overrides = {}) {
    const pkgDir = path.join(root, '@test', 'pkg');
    const abi = [{ type: 'function', name: 'x', inputs: [], outputs: [] }];
    const artifact = {
      name: 'Foo',
      contractName: 'Foo',
      sourcePath: 'src/Foo.sol',
      scopeHint: 'sew',
      category: 'core',
      abi,
      bytecode: overrides.fileBytecode ?? '0x6000',
      deployedBytecode: '0x60',
      linkReferences: {},
      deployedLinkReferences: {},
      metadata: 'mock',
      ...overrides.artifactOverride,
    };
    const fileBuf = Buffer.from(JSON.stringify(artifact), 'utf8');
    fs.writeFileSync(path.join(pkgDir, 'artifacts', 'Foo.json'), fileBuf);

    const base = {
      schemaVersion: 1,
      packageName: '@test/pkg',
      bundleVersion: overrides.version ?? '1.0.0',
      source: overrides.source ?? { repository: 'org/repo', commit: 'abc', commitSource: 'git', commitOverride: false, dirty: false },
      build: {
        artifactSource: 'forge',
        profile: 'default',
        compiler: { name: 'solc', version: '0.8.26' },
        settings: { evmVersion: 'osaka', optimizerRuns: 200, viaIR: true },
      },
      artifacts: {
        Foo: {
          contractName: 'Foo',
          sourcePath: 'src/Foo.sol',
          scopeHint: 'sew',
          category: 'core',
          artifactFile: overrides.artifactFile ?? 'artifacts/Foo.json',
          abiSha256: shaStr(canonicalJson(abi)),
          creationBytecodeSha256: overrides.manifestBytecodeHash ?? bcHash('0x6000'),
          runtimeBytecodeSha256: bcHash('0x60'),
          fileSha256: sha(fileBuf),
          hasLinkReferences: false,
          hasDeployedLinkReferences: false,
        },
      },
    };
    const bundleRoot = shaStr(canonicalJson(base));
    fs.writeFileSync(manifestPath(), JSON.stringify({ ...base, bundleRoot }));
  }

  it('binds a valid artifact', () => {
    writeBundle();
    const a = consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo');
    expect(a.artifactName).toBe('Foo');
    expect(a.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects artifact file hash mismatch (tampered artifact)', () => {
    writeBundle();
    const p = path.join(root, '@test', 'pkg', 'artifacts', 'Foo.json');
    fs.writeFileSync(p, Buffer.from(JSON.stringify({ name: 'Foo', contractName: 'Foo', abi: [], bytecode: '0xdeadbeef', deployedBytecode: '0x60', linkReferences: {}, deployedLinkReferences: {} })));
    try {
      consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo');
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('ARTIFACT_HASH_MISMATCH');
    }
  });

  it('rejects component (creation bytecode) hash mismatch', () => {
    writeBundle({ manifestBytecodeHash: 'deadbeef'.repeat(8) });
    try {
      consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo');
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('ARTIFACT_HASH_MISMATCH');
    }
  });

  it('rejects artifact missing from package', () => {
    writeBundle();
    try {
      consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Missing');
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('ARTIFACT_MISSING');
    }
  });

  it('rejects source not found (no manifest)', () => {
    try {
      consumer.bindArtifact('src', '@test/nope', '1.0.0', 'Foo');
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('ARTIFACT_SOURCE_NOT_FOUND');
    }
  });

  it('rejects package/version mismatch between request and manifest', () => {
    writeBundle();
    try {
      consumer.bindArtifact('src', '@test/pkg', '9.9.9', 'Foo');
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('ARTIFACT_SOURCE_MISMATCH');
    }
  });

  it('rejects a tampered bundle root', () => {
    writeBundle();
    rewriteManifest(() => {}, '0x' + '11'.repeat(32));
    expectBundleCode(() => consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'BUNDLE_ROOT_MISMATCH');
  });

  it('rejects an unparseable manifest', () => {
    writeBundle();
    fs.writeFileSync(manifestPath(), '{ not json');
    expectBundleCode(() => consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'ARTIFACT_MANIFEST_INVALID');
  });

  it('rejects a manifest that fails the exporter schema', () => {
    writeBundle();
    fs.writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 1 }));
    expectBundleCode(() => consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'ARTIFACT_MANIFEST_SCHEMA');
  });

  it('rejects an artifact file that cannot be read', () => {
    writeBundle({ artifactFile: 'artifacts/Nope.json' });
    expectBundleCode(() => consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'ARTIFACT_UNREADABLE');
  });

  it('rejects an artifact that fails its schema', () => {
    writeBundle({ artifactOverride: { bytecode: undefined } });
    expectBundleCode(() => consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'ARTIFACT_SCHEMA');
  });

  it('rejects an artifact whose name does not match the request', () => {
    writeBundle({ artifactOverride: { name: 'Bar' } });
    expectBundleCode(() => consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'ARTIFACT_NAME_MISMATCH');
  });

  it('rejects invalid bytecode', () => {
    writeBundle({ artifactOverride: { bytecode: 'not-hex' } });
    expectBundleCode(() => consumer.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'ARTIFACT_BYTECODE_INVALID');
  });

  it('exposes the locator it was built with', () => {
    const fixture = new FixtureBundleLocator('/fixtures');
    expect(fixture.resolve('sew/deployables', '@sew/deployables')).toBe(path.join('/fixtures', '@sew', 'deployables'));
    const npm = new NpmBundleLocator('/nm');
    expect(npm.resolve('sew/deployables', '@sew/deployables')).toBe(path.join('/nm', '@sew', 'deployables'));
    const routed = new SourceMapBundleLocator(
      { 'sew/deployables': 'fixture', 'prf/deployables': 'npm' },
      fixture,
      npm,
    );
    expect(routed.resolve('sew/deployables', '@sew/deployables')).toBe(path.join('/fixtures', '@sew', 'deployables'));
    expect(routed.resolve('prf/deployables', '@protocol-robustness/prf-evm-deployables')).toBe(path.join('/nm', '@protocol-robustness', 'prf-evm-deployables'));
  });

  it('accepts a clean git checkout under the pinned-provenance policy', () => {
    writeBundle({ source: { repository: 'org/repo', commit: 'a'.repeat(40), commitSource: 'git', commitOverride: false, dirty: false } });
    const pinned = new BundleConsumer(new FixtureBundleLocator(root), { requirePinnedProvenance: true });
    expect(pinned.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo').artifactName).toBe('Foo');
  });

  it('rejects dirty, jj-sourced or non-git-sha bundles under the pinned-provenance policy', () => {
    const pinned = () => new BundleConsumer(new FixtureBundleLocator(root), { requirePinnedProvenance: true });
    const clean = { repository: 'org/repo', commit: 'a'.repeat(40), commitSource: 'git', commitOverride: false, dirty: false };

    writeBundle({ source: { ...clean, dirty: true } });
    expectBundleCode(() => pinned().bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'BUNDLE_PROVENANCE_UNPINNED');

    writeBundle({ source: { ...clean, commitSource: 'jj' } });
    expectBundleCode(() => pinned().bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'BUNDLE_PROVENANCE_UNPINNED');

    writeBundle({ source: { ...clean, commit: 'deadbeef' } });
    expectBundleCode(() => pinned().bindArtifact('src', '@test/pkg', '1.0.0', 'Foo'), 'BUNDLE_PROVENANCE_UNPINNED');
  });

  it('selects fixtures for local development and packages otherwise', () => {
    writeBundle();
    const local = createBundleConsumer({
      sources: { 'sew/deployables': { kind: 'npm' } },
      fixtureRoot: root,
      preferFixtures: true,
    });
    expect(local.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo').artifactName).toBe('Foo');

    const packed = createBundleConsumer({
      sources: { 'sew/deployables': { kind: 'npm' } },
      fixtureRoot: path.join(root, 'no-fixtures-here'),
      nodeModulesDir: root,
      preferFixtures: false,
    });
    // `npm` kind routes to node_modules even when its fixture tree is absent.
    expect(packed.bindArtifact('src', '@test/pkg', '1.0.0', 'Foo').artifactName).toBe('Foo');
  });
});
