import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';
import { readEdnFile } from '../src/config/edn';
import { validateSuccessorEntitlementProfile } from '../src/validate/successor-entitlement-profile';

const root = path.resolve(__dirname, '..');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'config/pro-rata-v2-entitlement/base-sepolia.profile.json'), 'utf8')) as Record<string, any>;
const bundleConsumer = new BundleConsumer(new FixtureBundleLocator(path.join(root, 'fixtures/releases/0.4.0/packages')), { requirePinnedProvenance: true });
const bundle = bundleConsumer.loadManifest('prf/deployables', '@protocol-robustness/prf-evm-deployables', '0.4.0');
const localArchitecture = readEdnFile(path.join(root, 'config/pro-rata-v2-entitlement/architecture.edn'));
const localEnvironment = readEdnFile(path.join(root, 'config/pro-rata-v2-entitlement/environments/local.edn'));

describe('Base Sepolia successor-entitlement readiness profile', () => {
  it('validates pinned identities while explicitly remaining blocked', () => {
    const result = validateSuccessorEntitlementProfile(profile, bundle, localArchitecture, localEnvironment);
    expect(result.profileIntegrity).toBe('valid');
    expect(result.deploymentStatus).toBe('blocked');
    expect(result.unresolvedDependencies.length).toBeGreaterThan(0);
    expect(profile.readiness.deploymentEnabled).toBe(false);
    expect(profile.readiness.admissionEnabled).toBe(false);
    expect(profile.environment.chainId).toBe(84532);
    expect(profile.governanceToken.identity.symbol).toBe('SEW');
    expect(profile.operationToken.identity.symbol).toBe('USDC');
    expect(profile.governanceToken.identity.address).not.toBe(profile.operationToken.identity.address);
    expect(profile.operationToken.controlledAmounts.unit).toContain('6 decimals');
    expect(profile.operationToken.reservePlan.availableAmount).toBe(profile.operationToken.controlledAmounts.total);
    for (const contract of profile.contracts) {
      const loaded = bundleConsumer.loadArtifact('prf/deployables', '@protocol-robustness/prf-evm-deployables', '0.4.0', contract.type);
      expect(bundle.artifacts[contract.type]?.runtimeBytecodeSha256).toBe(contract.runtimeBytecodeSha256);
      expect(loaded.artifact.name).toBe(contract.type);
    }
  });

  it('rejects an unresolved profile presented as deployable or admitted', () => {
    const altered = structuredClone(profile);
    altered.readiness.deploymentEnabled = true;
    altered.readiness.admissionEnabled = true;
    expect(validateSuccessorEntitlementProfile(altered, bundle, localArchitecture, localEnvironment).profileIntegrity).toBe('invalid');
  });

  it('rejects a candidate artifact root that differs from the clean pinned release', () => {
    const altered = structuredClone(profile);
    altered.artifactBundle.bundleRoot = `0x${'1'.repeat(64)}`;
    expect(validateSuccessorEntitlementProfile(altered, bundle, localArchitecture, localEnvironment).profileIntegrity).toBe('invalid');
  });

  it('rejects a proof program identity that diverges from the existing local successor pin', () => {
    const altered = structuredClone(profile);
    altered.proofProgram.vkey = `0x${'1'.repeat(64)}`;
    expect(validateSuccessorEntitlementProfile(altered, bundle, localArchitecture, localEnvironment).profileIntegrity).toBe('invalid');
  });

  it('rejects filler roots and cannot become ready while authority references remain unresolved', () => {
    const withPlaceholder = structuredClone(profile);
    (withPlaceholder as Record<string, unknown>).untrustedRoot = `0x${'3'.repeat(64)}`;
    expect(validateSuccessorEntitlementProfile(withPlaceholder, bundle, localArchitecture, localEnvironment).profileIntegrity).toBe('invalid');

    const falselyReady = structuredClone(profile);
    falselyReady.readiness.unresolvedDependencies = [];
    falselyReady.readiness.status = 'ready';
    falselyReady.readiness.deploymentEnabled = true;
    falselyReady.readiness.admissionEnabled = true;
    const result = validateSuccessorEntitlementProfile(falselyReady, bundle, localArchitecture, localEnvironment);
    expect(result.profileIntegrity).toBe('invalid');
    expect(result.deploymentStatus).toBe('blocked');
  });

  it('rejects contract runtime hashes that do not match the pinned release', () => {
    const altered = structuredClone(profile);
    altered.contracts[0].runtimeBytecodeSha256 = '0'.repeat(64);
    expect(validateSuccessorEntitlementProfile(altered, bundle, localArchitecture, localEnvironment).profileIntegrity).toBe('invalid');
  });
});
