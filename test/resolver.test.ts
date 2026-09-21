import { describe, it, expect } from 'vitest';
import { resolveEdn } from './helpers';
import { resolveDeployment } from '../src/resolve-deployment';
import { CONFIG_DIR, FIXTURE_ROOT } from './helpers';

describe('resolver happy path', () => {
  it('resolves the baseline into a fully explicit spec', () => {
    const { spec } = resolveEdn();
    expect(Object.keys(spec.contracts)).toHaveLength(5);
    expect(spec.chain.chainId).toBe(31337);
    expect(spec.deployment.steps).toHaveLength(5);
    // every contract bound to a validated artifact with provenance
    for (const c of Object.values(spec.contracts)) {
      expect(c.artifact.sourceRepo).toBeTruthy();
      expect(c.artifact.artifactName).toBe(c.artifactName);
      expect(c.artifact.creationBytecodeSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(c.artifact.abi)).toBe(true);
    }
  });

  it('applies the real local environment overlay', () => {
    const out = resolveDeployment({ configDir: CONFIG_DIR, environment: 'local', fixtureRoot: FIXTURE_ROOT });
    const name = out.spec.contracts['shared/governance-token']!.parameters.find((p) => p.name === 'name')!;
    expect(name.value).toBe('Local Governance Token');
    expect(name.valueSource).toBe('environment');
    expect(name.overriddenByEnv).toBe(true);
    // governed param overridden by env keeps its governance authority
    const rate = out.spec.contracts['sew/escrow-vault']!.parameters.find((p) => p.name === 'interestRateBps')!;
    expect(rate.value).toBe('300');
    expect(rate.mutability).toBe('governed');
  });

  it('base-sepolia resolves to chain id 84532', () => {
    const out = resolveDeployment({ configDir: CONFIG_DIR, environment: 'base-sepolia', fixtureRoot: FIXTURE_ROOT });
    expect(out.spec.chain.chainId).toBe(84532);
    expect(out.spec.chain.logicalRole).toBe('testnet');
  });

  it('spec hash is deterministic across runs', () => {
    const a = resolveDeployment({ configDir: CONFIG_DIR, environment: 'local', fixtureRoot: FIXTURE_ROOT });
    const b = resolveDeployment({ configDir: CONFIG_DIR, environment: 'local', fixtureRoot: FIXTURE_ROOT });
    expect(a.specHash).toBe(b.specHash);
    expect(a.canonicalJson).toBe(b.canonicalJson);
  });
});
