import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';
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
    };
    const fileBuf = Buffer.from(JSON.stringify(artifact), 'utf8');
    fs.writeFileSync(path.join(pkgDir, 'artifacts', 'Foo.json'), fileBuf);

    const base = {
      schemaVersion: 1,
      packageName: '@test/pkg',
      bundleVersion: overrides.version ?? '1.0.0',
      source: { repository: 'org/repo', commit: 'abc', commitSource: 'git', commitOverride: false, dirty: false },
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
          artifactFile: 'artifacts/Foo.json',
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
    fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify({ ...base, bundleRoot }));
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
});
