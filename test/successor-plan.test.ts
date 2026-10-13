import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadEnvironment } from '../src/config/load';
import { assertNoPlaceholderRootBindings, assertPlanDeployable, projectConfigurationForPlan, readDeploymentUnitCatalog, readSuccessorDeploymentPlan, unsupportedDeploymentPrerequisite, validateArchitectureUnitOwnership, validatePlanAgainstUnits, validateSuccessorDeploymentPlan } from '../src/deployment/successor-plan';
import { assertPlanExecutionMatchesManifest, deploymentPlanHash, planExecutionRoot } from '../src/deployment/plan-execution';
import { computeManifestRoot, type DeploymentManifestV1 } from '../src/deployment/manifest';
import { resolveDeployment } from '../src/resolve-deployment';

const root = path.resolve(__dirname, '..');
const planPath = path.join(root, 'config/pro-rata-v2-entitlement/successor-fork.plan.v1.json');
const unitsPath = path.join(root, 'config/deployment-units.v1.json');
const plan = readSuccessorDeploymentPlan(planPath);
const units = readDeploymentUnitCatalog(unitsPath);

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try { fn(); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject({ code });
}

describe('bounded successor deployment plan', () => {
  it('selects only the three successor units and validates every explicit source', () => {
    expect(plan.selectedUnits).toEqual(['prf-assurance', 'protected-operations', 'pro-rata-successor-entitlements']);
    expect(plan.excludedUnits).toContain('sew-protocol');
    expect(() => validatePlanAgainstUnits(plan, units)).not.toThrow();
  });

  it('projects the real local profile to exactly the plan-selected deployment graph', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const projected = projectConfigurationForPlan(
      loadConfig({ configDir, profileDir }),
      loadEnvironment(configDir, 'local', profileDir),
      plan,
    );
    expect(projected.deployedLogicalIds).toEqual([
      'prf/local-token', 'prf/governance-authority', 'prf/verifier-registry',
      'prf/sp1-verifier-groth16', 'prf/source-bound-entitlement-verifier-adapter-v1',
      'prf/genesis', 'prf/configuration-executor', 'prf/statement-admission',
      'shortfall/prepared-operation-controller-v2', 'shortfall/pro-rata-allocator-v2',
      'shortfall/shortfall-reserve-v2', 'shortfall/source-bound-entitlement-assurance-v1',
      'shortfall/entitlement-ratification-controller-v1',
    ]);
    expect(projected.consumedExternalIds).toEqual([]);
    expect(Object.keys(projected.config.architecture.contracts).sort()).toEqual(Object.keys(plan.contracts).sort());
  });

  it('rejects sentinel root literals before the selected plan becomes deployable', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    expectCode(() => assertNoPlaceholderRootBindings(
      loadConfig({ configDir, profileDir }), Object.keys(plan.contracts),
    ), 'PLAN_PLACEHOLDER_ROOT_BINDING');
    expectCode(() => resolveDeployment({
      configDir,
      environment: 'local',
      fixtureRoot: path.join(root, 'fixtures/releases/0.4.0/packages'),
      profileDir,
      preferFixtures: true,
      deploymentPlanFile: planPath,
    }), 'PLAN_PLACEHOLDER_ROOT_BINDING');
  });

  it('identifies the first unimplemented stage required before a fresh plan deployment can proceed', () => {
    expect(unsupportedDeploymentPrerequisite(plan)).toEqual({ contract: 'prf/governance-authority', stage: 'derive-genesis-roots' });
    expectCode(() => assertPlanDeployable(plan), 'PLAN_STAGE_EXECUTOR_UNAVAILABLE');
  });

  it('rejects cyclic stage dependencies before topological-order validation', () => {
    const cyclic = structuredClone(plan);
    cyclic.stages.find((stage) => stage.id === 'deploy-local-token')!.dependsOn = ['derive-genesis-roots'];
    cyclic.stages.find((stage) => stage.id === 'derive-genesis-roots')!.dependsOn = ['deploy-local-token'];
    expectCode(() => validateSuccessorDeploymentPlan(cyclic), 'DEPLOYMENT_PLAN_STAGE_CYCLE');
  });

  it('derives initial configuration only after address-bound inputs exist and uses the empty registry root', () => {
    const stageIndex = new Map(plan.stages.map((stage, index) => [stage.id, index]));
    const initialRoots = plan.stages.find((stage) => stage.id === 'derive-genesis-roots')!;
    const deployAuthority = plan.stages.find((stage) => stage.id === 'deploy-authority-and-verifier')!;
    const deployToken = plan.stages.find((stage) => stage.id === 'deploy-local-token')!;
    const initialConfiguration = plan.stages.find((stage) => stage.id === 'derive-initial-configuration')!;
    const deriveSuccessorRegistry = plan.stages.find((stage) => stage.id === 'derive-registry-roots')!;
    const sealEmptyRegistry = plan.stages.find((stage) => stage.id === 'seal-empty-verifier-registry')!;
    const deployGenesis = plan.stages.find((stage) => stage.id === 'deploy-genesis')!;

    expect(stageIndex.get(initialRoots.id)).toBeLessThan(stageIndex.get(deployAuthority.id)!);
    expect(stageIndex.get(deployToken.id)).toBeLessThan(stageIndex.get(initialConfiguration.id)!);
    expect(stageIndex.get(deployAuthority.id)).toBeLessThan(stageIndex.get(initialConfiguration.id)!);
    expect(stageIndex.get(initialConfiguration.id)).toBeLessThan(stageIndex.get(deployGenesis.id)!);
    expect(initialRoots.produces).toContain('emptyRegistryRoot');
    expect(initialRoots.produces).not.toContain('initialConfigurationRoot');
    expect(initialRoots.consumes).not.toHaveProperty('successorRegistryRoot');
    expect(initialConfiguration.produces).toContain('initialConfigurationRoot');
    expect(initialConfiguration.consumes.emptyRegistryRoot).toEqual({
      stage: 'derive-genesis-roots', output: 'emptyRegistryRoot',
    });
    expect(initialConfiguration.consumes.localToken).toEqual({
      stage: 'deploy-local-token', output: 'localToken',
    });
    expect(initialConfiguration.consumes.successorAdapter).toEqual({
      stage: 'deploy-authority-and-verifier', output: 'successorAdapter',
    });
    expect(deriveSuccessorRegistry.produces).toEqual(['successorRegistryRoot']);
    expect(sealEmptyRegistry.consumes.emptyRegistryRoot).toEqual({
      stage: 'derive-genesis-roots', output: 'emptyRegistryRoot',
    });
    expect(deployGenesis.consumes.initialConfigurationRoot).toEqual({
      stage: 'derive-initial-configuration', output: 'initialConfigurationRoot',
    });
  });

  it('records PRF-owned genesis derivations without promoting candidate semantic inputs', () => {
    const graph = JSON.parse(fs.readFileSync(path.join(root, 'config/pro-rata-v2-entitlement/genesis-dependency-graph.v1.json'), 'utf8')) as {
      schema: string;
      qualification: string;
      roots: Array<{ id: string; producer: string; artifactStatus: string; inputs: string[] }>;
      cycleAssessment: string;
    };
    const byId = new Map(graph.roots.map((entry) => [entry.id, entry]));
    expect(graph.schema).toBe('prf-successor-genesis-dependency-graph.v1');
    expect(graph.qualification).toBe('candidate-map-only');
    expect(byId.get('protocolGenesisRoot')!.producer).toBe('resolver-sim.genesis/protocol-genesis-root');
    expect(byId.get('protocolGenesisRoot')!.artifactStatus).toContain('requires-owner-approval');
    expect(byId.get('authorityStateRoot')!.artifactStatus).toContain('missing-semantic-definition');
    expect(byId.get('initialConfigurationRoot')!.inputs).toContain('verifier-registry/root = emptyRegistryRoot');
    expect(byId.get('successorRegistryRoot')!.artifactStatus).toContain('not executed');
    expect(graph.cycleAssessment).toContain('No constructor cycle identified');
  });

  it('rejects a local-only fixture plan on a public chain', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const environment = loadEnvironment(configDir, 'local', profileDir);
    expectCode(() => projectConfigurationForPlan(loadConfig({ configDir, profileDir }), {
      ...environment, chain: { ...environment.chain, kind: 'testnet' },
    }, plan), 'LOCAL_FIXTURE_PUBLIC_ENVIRONMENT');
    expect(() => projectConfigurationForPlan(loadConfig({ configDir, profileDir }), {
      ...environment, chain: { ...environment.chain, kind: 'testnet' },
    }, plan, { allowLocalFork: true })).not.toThrow();
  });

  it('does not resolve or require unrelated contracts outside a selected plan', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const config = loadConfig({ configDir, profileDir });
    config.architecture.contracts['sew/unselected-invalid'] = {
      scope: 'sew', artifactSource: 'missing-unselected-source', artifact: 'NeverLoaded',
    };
    const projected = projectConfigurationForPlan(config, loadEnvironment(configDir, 'local', profileDir), plan);
    expect(projected.config.architecture.contracts['sew/unselected-invalid']).toBeUndefined();
    expect(projected.deployedLogicalIds).not.toContain('sew/unselected-invalid');
  });

  it('rejects an unselected dependency referenced by a selected constructor', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const config = loadConfig({ configDir, profileDir });
    config.architecture.contracts['shortfall/shortfall-reserve-v2']!.relationships = { dependsOn: ['sew/unselected-invalid'] };
    expectCode(() => projectConfigurationForPlan(config, loadEnvironment(configDir, 'local', profileDir), plan), 'PLAN_UNRESOLVED_CONSTRUCTOR_DEPENDENCY');
  });

  it('requires external dependencies to be explicit in the selected environment', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const configured = loadConfig({ configDir, profileDir });
    const environment = loadEnvironment(configDir, 'local', profileDir);
    const selectedExternal = structuredClone(plan);
    selectedExternal.contracts['prf/local-token'] = {
      kind: 'external', unit: 'protected-operations', dependencyId: 'test-asset', stage: 'deploy-local-token',
    };
    expectCode(() => projectConfigurationForPlan(configured, environment, selectedExternal), 'PLAN_EXTERNAL_UNRESOLVED');
  });

  it('fails closed for unresolved stage-output and admitted-release dependencies', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const config = loadConfig({ configDir, profileDir });
    const environment = loadEnvironment(configDir, 'local', profileDir);
    const stageOutput = structuredClone(plan);
    stageOutput.contracts['prf/source-bound-entitlement-verifier-adapter-v1'] = {
      kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier', output: 'successorAdapter',
    };
    stageOutput.stages.find((stage) => stage.id === 'deploy-authority-and-verifier')!.dependsOn = ['deploy-local-token'];
    expectCode(() => projectConfigurationForPlan(config, environment, stageOutput), 'PLAN_STAGE_OUTPUT_UNSUPPORTED');
    const admitted = structuredClone(plan);
    admitted.contracts['prf/sp1-verifier-groth16'] = {
      kind: 'admitted-release', unit: 'prf-assurance', releaseId: 'missing-release', logicalId: 'sp1-verifier-groth16',
    };
    expectCode(() => projectConfigurationForPlan(config, environment, admitted), 'PLAN_ADMITTED_RELEASE_UNSUPPORTED');
  });

  it('independently checks that immutable manifest deployments equal the selected plan sources', () => {
    const deployed = Object.entries(plan.contracts).filter(([, source]) => source.kind === 'deploy' || source.kind === 'local-fixture');
    const manifest: DeploymentManifestV1 = {
      type: 'protocol-deployment-manifest/v1',
      architectureSpecHash: '0x01', executionSpecHash: '0x02', deploymentId: 'test-run',
      chain: { id: 31337, blockNumber: '1', blockHash: `0x${'11'.repeat(32)}` as `0x${string}` },
      deployer: `0x${'22'.repeat(20)}` as `0x${string}`,
      contracts: deployed.map(([logicalId]) => ({
        logicalId,
        address: `0x${'33'.repeat(20)}` as `0x${string}`,
        artifact: { source: 'test', package: 'test', version: '1', artifactName: 'Test', abiSha256: '0'.repeat(64), creationBytecodeSha256: '0'.repeat(64), runtimeBytecodeSha256: '0'.repeat(64) },
        deploymentTx: `0x${'44'.repeat(32)}` as `0x${string}`,
        blockNumber: '1',
      })),
      bootstrapActions: [], finalAssertions: [],
    };
    const stageStatuses = new Map<string, string>();
    const body = {
      type: 'protocol-deployment-plan-execution/v1',
      planId: plan.planId,
      planHash: deploymentPlanHash(plan),
      environment: 'test', chainId: 31337, localOnly: true,
      selectedUnits: plan.selectedUnits, excludedUnits: plan.excludedUnits,
      selectedContracts: Object.entries(plan.contracts).map(([logicalId, source]) => ({ logicalId, ...source })),
      manifestRoot: computeManifestRoot(manifest),
      stages: plan.stages.map((stage) => {
        const prerequisitesSatisfied = stage.dependsOn.every((dependency) => ['verified', 'not-applicable'].includes(stageStatuses.get(dependency) ?? ''));
        if (stage.kind !== 'deploy') {
          const status = stage.kind === 'external-preflight' ? 'not-applicable' : 'not-executed';
          stageStatuses.set(stage.id, status);
          return { id: stage.id, kind: stage.kind, status };
        }
        const members = deployed.filter(([, source]) => 'stage' in source && source.stage === stage.id);
        const status = !prerequisitesSatisfied ? 'blocked' : members.length ? 'verified' : 'pending';
        stageStatuses.set(stage.id, status);
        return {
          id: stage.id, kind: stage.kind, status,
          outputs: Object.fromEntries(members.map(([logicalId]) => {
            const fact = manifest.contracts.find((contract) => contract.logicalId === logicalId)!;
            return [logicalId, { address: fact.address, transactionHash: fact.deploymentTx, blockNumber: fact.blockNumber, runtimeBytecodeSha256: fact.artifact.runtimeBytecodeSha256 }];
          })),
        };
      }),
    };
    const receipt = { ...body, planExecutionRoot: planExecutionRoot(body) };
    expect(() => assertPlanExecutionMatchesManifest(receipt, plan, manifest)).not.toThrow();
    const dependencyViolation = structuredClone(receipt);
    dependencyViolation.stages.find((stage) => stage.id === 'deploy-genesis')!.status = 'verified';
    const { planExecutionRoot: _oldRoot, ...dependencyBody } = dependencyViolation;
    dependencyViolation.planExecutionRoot = planExecutionRoot(dependencyBody);
    expectCode(() => assertPlanExecutionMatchesManifest(dependencyViolation, plan, manifest), 'PLAN_EXECUTION_STAGE_DEPENDENCY_MISMATCH');
    const substituted = { ...manifest, contracts: manifest.contracts.slice(1) };
    expectCode(() => assertPlanExecutionMatchesManifest(receipt, plan, substituted), 'PLAN_EXECUTION_MANIFEST_MISMATCH');
  });

  it('does not infer local-fixture versus external from a present address', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const environment = loadEnvironment(configDir, 'local', profileDir);
    expectCode(() => projectConfigurationForPlan(loadConfig({ configDir, profileDir }), {
      ...environment,
      externalContracts: { 'prf/local-token': { address: '0x0000000000000000000000000000000000000001' } },
    }, plan), 'PLAN_FIXTURE_EXTERNAL_CONFLICT');
  });

  it('rejects an explicit deploy source that is also bound as external', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const environment = loadEnvironment(configDir, 'local', profileDir);
    const conflicting = structuredClone(plan);
    conflicting.contracts['prf/governance-authority'] = {
      kind: 'deploy', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier',
    };
    expectCode(() => projectConfigurationForPlan(loadConfig({ configDir, profileDir }), {
      ...environment,
      externalContracts: { 'prf/governance-authority': { address: `0x${'11'.repeat(20)}` } },
    }, conflicting), 'PLAN_DEPLOY_EXTERNAL_CONFLICT');
  });

  it('rejects an external source left in the environment deployment order', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const environment = loadEnvironment(configDir, 'local', profileDir);
    const conflicting = structuredClone(plan);
    conflicting.contracts['prf/local-token'] = {
      kind: 'external', unit: 'protected-operations', dependencyId: 'token', stage: 'deploy-local-token',
    };
    expectCode(() => projectConfigurationForPlan(loadConfig({ configDir, profileDir }), {
      ...environment,
      externalContracts: { 'prf/local-token': { address: `0x${'11'.repeat(20)}` } },
    }, conflicting), 'PLAN_EXTERNAL_IN_DEPLOY_ORDER');
  });

  it('rejects an external or local-fixture source that conflicts with unit ownership', () => {
    const fixture = structuredClone(plan);
    fixture.contracts['prf/verifier-registry'] = {
      kind: 'external', unit: 'prf-assurance', dependencyId: 'unverified', stage: 'deploy-authority-and-verifier',
    };
    expectCode(() => validatePlanAgainstUnits(fixture, units), 'DEPLOYMENT_PLAN_SOURCE_MISMATCH');
  });

  it('rejects unknown contract identities instead of silently expanding the plan', () => {
    const fixture = structuredClone(plan);
    fixture.contracts['sew/governor'] = {
      kind: 'deploy', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier',
    };
    expectCode(() => validatePlanAgainstUnits(fixture, units), 'DEPLOYMENT_PLAN_UNKNOWN_CONTRACT');
  });

  it('rejects upgrading the fork plan to non-local use', () => {
    const fixture = structuredClone(plan);
    fixture.localOnly = false;
    expectCode(() => validateSuccessorDeploymentPlan(fixture), 'SUCCESSOR_PLAN_LOCAL_ONLY');
  });

  it('requires the controlled successor fork plan to stay local-only', () => {
    const fixture = structuredClone(plan);
    fixture.localOnly = false;
    expectCode(() => validateSuccessorDeploymentPlan(fixture), 'SUCCESSOR_PLAN_LOCAL_ONLY');
  });

  it('accepts explicit earlier-stage and admitted-release source forms without inferring a source', () => {
    const fromStage = structuredClone(plan);
    fromStage.stages.find((stage) => stage.id === 'deploy-authority-and-verifier')!.dependsOn.push('deploy-local-token');
    fromStage.contracts['prf/source-bound-entitlement-verifier-adapter-v1'] = {
      kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier', output: 'successorAdapter',
    };
    expect(() => validateSuccessorDeploymentPlan(fromStage)).not.toThrow();
    expect(() => validatePlanAgainstUnits(fromStage, units)).not.toThrow();
    const fromRelease = structuredClone(plan);
    fromRelease.contracts['prf/sp1-verifier-groth16'] = {
      kind: 'admitted-release', unit: 'prf-assurance', releaseId: 'prf/sp1-verifier-groth16/6.1.0', logicalId: 'sp1-verifier-groth16',
    };
    expect(() => validateSuccessorDeploymentPlan(fromRelease)).not.toThrow();
    expect(() => validatePlanAgainstUnits(fromRelease, units)).not.toThrow();
  });

  it('rejects dependencies on later stages and undeclared stage outputs', () => {
    const fixture = structuredClone(plan);
    fixture.stages[0]!.dependsOn = ['deploy-authority-and-verifier'];
    expectCode(() => validateSuccessorDeploymentPlan(fixture), 'DEPLOYMENT_PLAN_STAGE_ORDER');
    const missingOutput = structuredClone(plan);
    missingOutput.stages[2]!.dependsOn.push('deploy-local-token');
    missingOutput.stages[2]!.consumes!.notARealFact = { stage: 'deploy-local-token', output: 'notARealFact' };
    expectCode(() => validateSuccessorDeploymentPlan(missingOutput), 'DEPLOYMENT_PLAN_STAGE_OUTPUT');
  });

  it('keeps the unit catalog closed to malformed dependency classes', () => {
    const malformed = JSON.parse(fs.readFileSync(unitsPath, 'utf8'));
    malformed.units['prf-assurance'].contracts['prf/statement-admission'].dependencies.push('implicit-admin');
    const tempPath = path.join(root, '.tmp-deployment-units-test.json');
    fs.writeFileSync(tempPath, JSON.stringify(malformed));
    try {
      expectCode(() => readDeploymentUnitCatalog(tempPath), 'DEPLOYMENT_UNITS_INVALID');
    } finally {
      fs.unlinkSync(tempPath);
    }
  });

  it('assigns every generic and successor architecture contract to exactly one unit', () => {
    const generic = loadConfig({ configDir: path.join(root, 'config') });
    const successor = loadConfig({ configDir: path.join(root, 'config'), profileDir: path.join(root, 'config/pro-rata-v2-entitlement') });
    expect(() => validateArchitectureUnitOwnership(Object.keys(generic.architecture.contracts), units)).not.toThrow();
    expect(() => validateArchitectureUnitOwnership(Object.keys(successor.architecture.contracts), units)).not.toThrow();
    expectCode(() => validateArchitectureUnitOwnership(['unknown/contract'], units), 'DEPLOYMENT_UNIT_UNASSIGNED');
    const duplicate = structuredClone(units);
    duplicate.units['sew-protocol']!.contracts['prf/statement-admission'] = structuredClone(units.units['prf-assurance']!.contracts['prf/statement-admission']!);
    expectCode(() => validateArchitectureUnitOwnership(['prf/statement-admission'], duplicate), 'DEPLOYMENT_UNIT_MULTIPLE_OWNERS');
  });

  it('rejects deployment-plan cycles, missing selected units, and ambiguous unit ownership', () => {
    const cycle = structuredClone(plan);
    cycle.stages[1]!.dependsOn = ['deploy-genesis'];
    expectCode(() => validateSuccessorDeploymentPlan(cycle), 'DEPLOYMENT_PLAN_STAGE_CYCLE');
    const noUnit = structuredClone(plan);
    noUnit.selectedUnits = ['prf-assurance', 'protected-operations'] as never;
    expectCode(() => validateSuccessorDeploymentPlan(noUnit), 'DEPLOYMENT_PLAN_UNIT_MISSING');
    const conflict = structuredClone(plan);
    conflict.selectedUnits.push('sew-protocol');
    expectCode(() => validateSuccessorDeploymentPlan(conflict), 'DEPLOYMENT_PLAN_UNIT_CONFLICT');
    const missingSewExclusion = structuredClone(plan);
    missingSewExclusion.excludedUnits = [];
    expectCode(() => validateSuccessorDeploymentPlan(missingSewExclusion), 'SUCCESSOR_SEW_EXCLUSION');
  });

  it('rejects duplicate stages, invalid action targets, and actions without authorization stages', () => {
    const duplicate = structuredClone(plan);
    duplicate.stages.push(structuredClone(duplicate.stages[0]!));
    expectCode(() => validateSuccessorDeploymentPlan(duplicate), 'DEPLOYMENT_PLAN_STAGE_DUPLICATE');
    const target = structuredClone(plan);
    target.authorizedConfigurationActions[0]!.target = 'not-selected';
    expectCode(() => validateSuccessorDeploymentPlan(target), 'DEPLOYMENT_PLAN_AUTH_TARGET');
    const stage = structuredClone(plan);
    stage.authorizedConfigurationActions[0]!.stage = 'not-authorized';
    expectCode(() => validateSuccessorDeploymentPlan(stage), 'DEPLOYMENT_PLAN_AUTH_STAGE');
    const beforeDeploy = structuredClone(plan);
    beforeDeploy.authorizedConfigurationActions[0]!.target = 'prf/configuration-executor';
    beforeDeploy.authorizedConfigurationActions[0]!.stage = 'seal-empty-verifier-registry';
    expectCode(() => validateSuccessorDeploymentPlan(beforeDeploy), 'DEPLOYMENT_PLAN_AUTH_TARGET_ORDER');
  });

  it('rejects empty plans, unknown contract stages and undeclared stage dependencies', () => {
    const empty = structuredClone(plan);
    empty.contracts = {};
    expectCode(() => validateSuccessorDeploymentPlan(empty), 'DEPLOYMENT_PLAN_EMPTY');
    const badStage = structuredClone(plan);
    badStage.contracts['prf/genesis'] = { kind: 'deploy', unit: 'prf-assurance', stage: 'missing' };
    expectCode(() => validateSuccessorDeploymentPlan(badStage), 'DEPLOYMENT_PLAN_CONTRACT_STAGE');
    const undeclared = structuredClone(plan);
    undeclared.stages[1]!.consumes!.chain = { stage: 'deploy-local-token', output: 'chainId' };
    expectCode(() => validateSuccessorDeploymentPlan(undeclared), 'DEPLOYMENT_PLAN_STAGE_DEPENDENCY');
    const wrongUnit = structuredClone(plan);
    wrongUnit.contracts['prf/verifier-registry'] = { kind: 'deploy', unit: 'sew-protocol', stage: 'deploy-authority-and-verifier' };
    expectCode(() => validateSuccessorDeploymentPlan(wrongUnit), 'DEPLOYMENT_PLAN_CONTRACT_UNIT');
  });

  it('fails closed for unreadable plan and unit files', () => {
    expectCode(() => readSuccessorDeploymentPlan(path.join(root, 'does-not-exist.json')), 'DEPLOYMENT_PLAN_UNREADABLE');
    expectCode(() => readDeploymentUnitCatalog(path.join(root, 'does-not-exist-units.json')), 'DEPLOYMENT_UNITS_UNREADABLE');
    const badPlan = path.join(root, '.tmp-successor-plan-test.json');
    fs.writeFileSync(badPlan, '{"schema":"unknown"}');
    try {
      expectCode(() => readSuccessorDeploymentPlan(badPlan), 'DEPLOYMENT_PLAN_INVALID');
    } finally {
      fs.unlinkSync(badPlan);
    }
  });
});
