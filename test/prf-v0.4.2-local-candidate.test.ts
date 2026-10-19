import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';

const fixtureRoot = path.resolve('fixtures/releases/0.4.2/packages');
const packageName = '@protocol-robustness/prf-evm-deployables';
const bundleRoot = '5b9da0dfc6b1a2864d0ae174faef3ddf0095dab21b4a158de25aef677235b7ba';
const consumer = new BundleConsumer(new FixtureBundleLocator(fixtureRoot));

describe('PRF-EVM 0.4.2 local candidate artifact bundle', () => {
  it('pins the reviewed bundle root and source provenance', () => {
    const manifest = consumer.loadManifest('prf', packageName, '0.4.2');
    expect(manifest.bundleRoot).toBe(bundleRoot);
    expect(manifest.source).toMatchObject({
      commit: '8ba7628bdfa46c1673aa15ba6205443ac1750ea9',
      commitSource: 'jj',
      commitOverride: true,
      dirty: false,
    });
    expect(Object.keys(manifest.artifacts)).toHaveLength(30);
  });

  it('loads all three changed PRF core artifacts with their manifest hashes', () => {
    for (const name of ['PrfChainInstanceGenesis', 'PrfStatementAdmission', 'PrfLocalAuthorityAdapter']) {
      const loaded = consumer.loadArtifact('prf', packageName, '0.4.2', name);
      expect(loaded.artifact.bytecode).not.toBe('0x');
      expect(loaded.artifact.deployedBytecode).not.toBe('0x');
    }
  });
});
