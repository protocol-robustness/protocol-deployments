import { describe, it, expect } from 'vitest';
import { resolveEdn } from './helpers';
import { resolveDeployment } from '../src/resolve-deployment';
import { CONFIG_DIR, FIXTURE_ROOT } from './helpers';
import * as path from 'path';
import { materializeExecutionSpec } from '../src/deployment/execution-spec';

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

  it('wires testnet governance so the governor can propose, and asserts it', () => {
    const { spec } = resolveDeployment({ configDir: CONFIG_DIR, environment: 'base-sepolia', fixtureRoot: FIXTURE_ROOT });
    const grant = spec.deployment.bootstrapActions?.find((action) => action.id === 'timelock/grant-governor-proposer');
    expect(grant).toBeDefined();
    expect(grant?.target).toBe('shared/timelock');
    expect(grant?.function).toBe('grantRole');
    expect(grant?.args[1]).toEqual({ kind: 'contract-address', contract: 'shared/governor' });

    const assertion = spec.deployment.bootstrapAssertions?.find((entry) => entry.id === 'timelock/governor-proposer');
    expect(assertion?.target).toBe('shared/timelock');
    expect(assertion?.expected).toBe(true);
  });

  it('resolves runtime-code-hash bootstrap bindings and preserves them in the execution spec', () => {
    const out = resolveDeployment({
      configDir: CONFIG_DIR,
      environment: 'local',
      profileDir: path.join(CONFIG_DIR, 'pro-rata'),
      fixtureRoot: FIXTURE_ROOT,
    });
    const seal = out.spec.deployment.bootstrapActions!.find((action) => action.id === 'prf/seal-genesis');
    expect(seal).toBeDefined();
    expect(seal!.args[1]).toEqual({ kind: 'runtime-code-hash', contract: 'prf/genesis' });
    expect(seal!.args[2]).toEqual({ kind: 'runtime-code-hash', contract: 'prf/governance-authority' });

    const materialized = materializeExecutionSpec(out.spec, out.specHash, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(materialized.executionSpecHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('spec hash is deterministic across runs', () => {
    const a = resolveDeployment({ configDir: CONFIG_DIR, environment: 'local', fixtureRoot: FIXTURE_ROOT });
    const b = resolveDeployment({ configDir: CONFIG_DIR, environment: 'local', fixtureRoot: FIXTURE_ROOT });
    expect(a.specHash).toBe(b.specHash);
    expect(a.canonicalJson).toBe(b.canonicalJson);
  });

  it('keeps the V2 optimistic Shortfall profile distinct from the stable V1 profile', () => {
    const v1 = resolveDeployment({
      configDir: CONFIG_DIR,
      environment: 'local',
      profileDir: path.join(CONFIG_DIR, 'pro-rata'),
      fixtureRoot: FIXTURE_ROOT,
    });
    const v2 = resolveDeployment({
      configDir: CONFIG_DIR,
      environment: 'local',
      profileDir: path.join(CONFIG_DIR, 'pro-rata-v2-ratification'),
      fixtureRoot: FIXTURE_ROOT,
    });

    expect(v1.specHash).not.toBe(v2.specHash);
    expect(v1.spec.deployment.registryRoots).toEqual(['prf/shortfall-reserve', 'prf/pro-rata-allocator']);
    expect(v2.spec.deployment.registryRoots).toEqual([
      'shortfall/source-bound-assurance-v2',
      'shortfall/ratification-controller-v2',
      'shortfall/shortfall-reserve-v2',
      'shortfall/pro-rata-allocator-v2',
    ]);
    expect(v2.spec.deployment.localOnly).toBe(true);
    expect(v2.spec.contracts['shortfall/pro-rata-allocator-v2']?.artifactName).toBe('ProductionProRataAllocatorV2');
    expect(v2.spec.contracts['shortfall/source-bound-assurance-v2']?.constructorBindings?.sourceAdapter_)
      .toEqual({ kind: 'contract-address', contract: 'prf/source-bound-verifier-adapter-v2' });
  });

  it('resolves typed final assertion bindings for the V2 topology', () => {
    const { spec } = resolveDeployment({
      configDir: CONFIG_DIR,
      environment: 'local',
      profileDir: path.join(CONFIG_DIR, 'pro-rata-v2-ratification'),
      fixtureRoot: FIXTURE_ROOT,
    });
    const authority = spec.deployment.bootstrapAssertions?.find((assertion) => assertion.id === 'shortfall-v2/allocator-funding-authority');
    expect(authority?.expected).toEqual({ kind: 'contract-address', contract: 'shortfall/shortfall-reserve-v2' });
  });
});


describe('qualified successor artifact isolation', () => {
  const profileDir = path.join(CONFIG_DIR, 'pro-rata-v2-entitlement');
  const fixtureRoot = path.resolve('fixtures/releases/0.4.0/packages');

  it('resolves the successor from clean pinned 0.4.0 artifacts', () => {
    const { spec } = resolveDeployment({ configDir: CONFIG_DIR, environment: 'local', profileDir, fixtureRoot,
      preferFixtures: true, requirePinnedProvenance: true });
    const adapter = spec.contracts['prf/source-bound-entitlement-verifier-adapter-v1']!;
    expect(adapter.constructorBindings?.vkey_).toEqual({ kind: 'literal', value: '0x00d90efa52d17e54670a4248f001e4da443a938f12c55d0d414c125ba68087b9' });
    expect(adapter.constructorBindings?.elfSha256_).toEqual({ kind: 'literal', value: '0x636330de8e7af3485aba50bd3ca4b5e024cc4f977a2bf0f2c005f711e5ffacf8' });
    const assurance = Object.values(spec.contracts).find(c => c.artifactName === 'SourceBoundProRataEntitlementAssuranceV1')!;
    expect(assurance.artifact.abi.some((entry: any) => entry.type === 'function' && entry.name === 'replaceStaleAssurance')).toBe(true);
    expect(spec.deployment.localOnly).toBe(true);
  });

  it('refuses to substitute the historical artifact bundle for the successor', () => {
    expect(() => resolveDeployment({ configDir: CONFIG_DIR, environment: 'local', profileDir, fixtureRoot: FIXTURE_ROOT })).toThrow();
  });
});
