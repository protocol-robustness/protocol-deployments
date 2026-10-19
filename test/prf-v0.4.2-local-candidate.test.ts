import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';

const fixtureRoot = path.resolve('fixtures/releases/0.4.2/packages');
const packageName = '@protocol-robustness/prf-evm-deployables';
const bundleRoot = '1c040be8f3364d303dc66cabd0bb676994c836eb4021e9216862dc991a9c3bae';
const consumer = new BundleConsumer(new FixtureBundleLocator(fixtureRoot));

describe('PRF-EVM 0.4.2 local candidate artifact bundle', () => {
  it('pins the reviewed bundle root and source provenance', () => {
    const manifest = consumer.loadManifest('prf', packageName, '0.4.2');
    expect(manifest.bundleRoot).toBe(bundleRoot);
    expect(manifest.source).toMatchObject({
      commit: '0dad4c2790a60ecca9a41c5d518f99522eab94ce',
      commitSource: 'git',
      commitOverride: false,
      dirty: false,
    });
    expect(Object.keys(manifest.artifacts)).toHaveLength(31);
  });

  it('loads all three changed PRF core artifacts with their manifest hashes', () => {
    for (const name of ['PrfChainInstanceGenesis', 'PrfStatementAdmission', 'PrfLocalAuthorityAdapter', 'PrfEcdsaAuthorityTransitionValidator']) {
      const loaded = consumer.loadArtifact('prf', packageName, '0.4.2', name);
      expect(loaded.artifact.bytecode).not.toBe('0x');
      expect(loaded.artifact.deployedBytecode).not.toBe('0x');
    }
  });
});
