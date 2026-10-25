import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { validatePro95DemoProfile } from '../src/validate/pro-95-demo-profile';

const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../config/pro-95-base-sepolia-demo/profile.v1.json'), 'utf8')) as Record<string, any>;

describe('PRO-95 Base Sepolia demo intake profile', () => {
  it('keeps the approved scenario explicit and deployment blocked', () => {
    expect(validatePro95DemoProfile(profile)).toEqual({ valid: true, errors: [] });
    expect(profile.limitations[0]).toContain('no Base or Ethereum consensus finality is established');
    expect(profile.readiness.broadcastAllowed).toBe(false);
    expect(profile.transactionPolicy.ethSpendCapWei).toBeNull();
    expect(profile.canonicalRoots.chainInstanceGenesisRoot).toBeNull();
    expect(profile.deploymentPackage.status).toBe('local-v3-candidate-not-pinned-or-base-qualified');
    expect(profile.deploymentPackage.pinnedArtifactBundle.bundleRoot).toBe('d416816527400fcc7bc7455a1486c1bc20cb94ed556473d0c695a83ea09e2dba');
    expect(profile.deploymentPackage.deploymentPlan).toBeNull();
  });

  it('rejects a profile that omits or demotes the finality qualification', () => {
    const changed = structuredClone(profile);
    changed.limitations.reverse();
    expect(validatePro95DemoProfile(changed).valid).toBe(false);
  });

  it('rejects a demo profile presented as deployable', () => {
    const changed = structuredClone(profile);
    changed.readiness.deploymentEnabled = true;
    expect(validatePro95DemoProfile(changed).valid).toBe(false);
  });

  it('rejects settlement arithmetic that merges unmet requests with liabilities', () => {
    const changed = structuredClone(profile);
    changed.controlledScenario.unmetRequestsAreRecognizedLiabilities = true;
    expect(validatePro95DemoProfile(changed).valid).toBe(false);
  });

  it('rejects substitution of another token or a mintable demo asset', () => {
    const changed = structuredClone(profile);
    changed.asset.address = '0x4cCa3115a7c13F68Cb2e1dF1c2c2dB87e15C9d2';
    expect(validatePro95DemoProfile(changed).valid).toBe(false);
  });

  it('preserves the 6-decimal USDC accounting amounts', () => {
    expect(profile.asset.decimals).toBe(6);
    expect(profile.controlledScenario.deposit).toBe(80_000_000);
    expect(profile.controlledScenario.fundedAllocations).toEqual({ alice: 35_000_000, bob: 21_000_000, carol: 14_000_000 });
  });
});
