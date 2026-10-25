import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';

const fixtureRoot = path.resolve('fixtures/releases/0.4.3/packages');
const packageName = '@protocol-robustness/prf-evm-deployables';
const bundleRoot = 'd416816527400fcc7bc7455a1486c1bc20cb94ed556473d0c695a83ea09e2dba';
const locator = new FixtureBundleLocator(fixtureRoot);

describe('PRO-95 PRF-EVM 0.4.3 V3 candidate bundle', () => {
  it('loads the pinned local candidate and its V3 reserve artifact', () => {
    const consumer = new BundleConsumer(locator);
    const manifest = consumer.loadManifest('prf', packageName, '0.4.3');
    expect(manifest.bundleRoot).toBe(bundleRoot);
    expect(manifest.source).toMatchObject({
      commit: 'f23fcfc2d0f58e2be5732c0c37ddb179c323d513',
      commitSource: 'env',
      commitOverride: true,
      dirty: false,
    });
    expect(Object.keys(manifest.artifacts)).toHaveLength(32);

    for (const artifactName of Object.keys(manifest.artifacts)) {
      expect(consumer.loadArtifact('prf', packageName, '0.4.3', artifactName).artifact.bytecode).not.toBe('0x');
    }

    const reserve = consumer.loadArtifact('prf', packageName, '0.4.3', 'OnchainShortfallReserveV3');
    expect(reserve.artifact.bytecode).not.toBe('0x');
    expect(reserve.artifact.deployedBytecode).not.toBe('0x');
    expect(manifest.artifacts.OnchainShortfallReserveV3?.sourcePath)
      .toBe('src/applications/shortfall/OnchainShortfallReserveV3.sol');
  });

  it('rejects the environment-overridden source provenance for non-local use', () => {
    const consumer = new BundleConsumer(locator, { requirePinnedProvenance: true });
    expect(() => consumer.loadManifest('prf', packageName, '0.4.3'))
      .toThrowError(expect.objectContaining({ code: 'BUNDLE_PROVENANCE_UNPINNED' }));
  });
});
