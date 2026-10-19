import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, loadEnvironment } from '../src/config/load';
import { assertNoPlaceholderRootBindings, assertPlanDeployable, bindStatementAdmissionSnapshot, executableDeploymentPrefix, projectConfigurationForPlan, readDeploymentUnitCatalog, readSuccessorDeploymentPlan, unsupportedDeploymentPrerequisite, validateArchitectureUnitOwnership, validatePlanAgainstUnits, validateSuccessorDeploymentPlan } from '../src/deployment/successor-plan';
import { assertPlanExecutionMatchesManifest, deploymentPlanHash, planExecutionRoot } from '../src/deployment/plan-execution';
import { computeManifestRoot, type DeploymentManifestV1, type DeploymentManifestV2 } from '../src/deployment/manifest';
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

  it('requires verifier runtime closure to bind the selected adapter and verifier stages in order', () => {
    expect(plan.verifierClosures).toHaveLength(1);
    const substitutedStage = structuredClone(plan);
    substitutedStage.verifierClosures[0]!.verifierStage = 'deploy-successor-entitlements';
    expectCode(() => validateSuccessorDeploymentPlan(substitutedStage), 'DEPLOYMENT_PLAN_VERIFIER_CLOSURE');
    const substitutedContract = structuredClone(plan);
    substitutedContract.verifierClosures[0]!.verifierLogicalId = 'shortfall/pro-rata-allocator-v2';
    expectCode(() => validateSuccessorDeploymentPlan(substitutedContract), 'DEPLOYMENT_PLAN_VERIFIER_CLOSURE');
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
      'prf/local-token', 'prf/authority-transition-validator', 'prf/governance-authority', 'prf/verifier-registry',
      'prf/sp1-verifier-groth16', 'prf/source-bound-entitlement-verifier-adapter-v1',
      'prf/genesis', 'prf/configuration-executor', 'prf/statement-admission',
      'shortfall/prepared-operation-controller-v2', 'shortfall/pro-rata-allocator-v2',
      'shortfall/shortfall-reserve-v2', 'shortfall/source-bound-entitlement-assurance-v1',
      'shortfall/entitlement-ratification-controller-v1',
    ]);
    expect(projected.consumedExternalIds).toEqual([]);
    expect(Object.keys(projected.config.architecture.contracts).sort()).toEqual(Object.keys(plan.contracts).sort());
    expect(projected.config.architecture.artifactSources['prf/deployables']?.version).toBe('0.4.2');
  });

  it('resolves the bounded local plan against the pinned PRF-EVM 0.4.2 candidate bundle', () => {
    const resolved = resolveDeployment({
      configDir: path.join(root, 'config'),
      environment: 'local',
      fixtureRoot: path.join(root, 'fixtures/releases/0.4.2/packages'),
      profileDir: path.join(root, 'config/pro-rata-v2-entitlement'),
      preferFixtures: true,
      deploymentPlanFile: planPath,
      approvedRootBindings: {
        protocolGenesisRoot: '0x668bc1d132b8745a3f6db7fa0b2dad2b85a11246e00c39e7b24d266af4724775',
        authorityStateRoot: '0x062aac742a56de1f3d51e1debc4fd8670b1dda8fc1acb68c0bbcd10ae1b8337e',
        localAuthorityPolicyRoot: '0x0e124c35e9707f03ddb7f0b2972c22715098a23b58804175df02acdd25ded55c',
        initialConfigurationRoot: '0x131ff6b74047de747bd9ace93413b6b793d677749095f0dadf5dcc173e120f95',
        initialVerifierRegistryRoot: '0x2099fabf2cca563f8d183749d1a842946286e8704a96c51ec801eff4e834a240',
        authorityTransitionValidatorAddress: '0xc78884593859e84524e41ce94cce38fbcb58c5f8',
      },
    });
    expect(resolved.spec.chain.chainId).toBe(31337);
    expect(Object.keys(resolved.spec.contracts)).toHaveLength(14);
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
      fixtureRoot: path.join(root, 'fixtures/releases/0.4.2/packages'),
      profileDir,
      preferFixtures: true,
      deploymentPlanFile: planPath,
    }), 'PLAN_PLACEHOLDER_ROOT_BINDING');
  });

  it('identifies the first unimplemented successor governance stage after the empty-root deployment prefix', () => {
    expect(unsupportedDeploymentPrerequisite(plan)).toEqual({ contract: 'prf/statement-admission', stage: 'authorize-successor-configuration' });
    expectCode(() => assertPlanDeployable(plan), 'PLAN_STAGE_EXECUTOR_UNAVAILABLE');
  });

  it('exposes the approval-gated prefix through successor registry sealing', () => {
    const prefix = executableDeploymentPrefix(plan);
    expect(prefix.contractIds).toEqual(new Set([
      'prf/local-token', 'prf/authority-transition-validator', 'prf/governance-authority', 'prf/verifier-registry',
      'prf/sp1-verifier-groth16', 'prf/source-bound-entitlement-verifier-adapter-v1', 'prf/genesis', 'prf/configuration-executor',
    ]));
    expect(prefix.stageIds).toContain('derive-genesis-roots');
    expect(prefix.stageIds).toContain('derive-initial-configuration');
    expect(prefix.stageIds).toContain('deploy-genesis');
    expect(prefix.stageIds).toContain('derive-chain-instance-root');
    expect(prefix.stageIds).toContain('seal-chain-instance-genesis');
    expect(prefix.stageIds).toContain('derive-registry-roots');
    expect(prefix.stageIds).toContain('seal-empty-verifier-registry');
    expect(prefix.stageIds).toContain('deploy-configuration-executor');
    expect(prefix.stageIds).toContain('derive-successor-configuration');
    expect(prefix.stageIds).toContain('verify-successor-transition-approval');
    expect(prefix.stageIds).toContain('register-successor-verifier');
    expect(prefix.stageIds).toContain('seal-successor-verifier-registry');
    expect(prefix.stageIds).not.toContain('authorize-successor-configuration');
    expect(prefix.contractIds).not.toContain('prf/statement-admission');
  });

  it('enables authority and C1 execution only when the signed transition request is available', () => {
    const prefix = executableDeploymentPrefix(plan, { authorityTransitionInput: true });
    expect(prefix.stageIds).toContain('authorize-successor-configuration');
    expect(prefix.stageIds).toContain('apply-successor-configuration');
    expect(prefix.stageIds).toContain('deploy-statement-admission');
    expect(prefix.stageIds).toContain('deploy-protected-operations');
    expect(prefix.stageIds).toContain('deploy-successor-entitlements');
    expect(prefix.contractIds).toContain('prf/statement-admission');
    expect(prefix.blockedStageIds).toContain('proof-admission-and-operation');
    expect(unsupportedDeploymentPrerequisite(plan)).toEqual({ contract: 'prf/statement-admission', stage: 'authorize-successor-configuration' });
  });

  it('binds statement admission to the applied C1 snapshot after its stage dependency', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const rootValue = (name: string): string => `0x${createHash('sha256').update(name).digest('hex')}`;
    const validatorAddress = `0x${createHash('sha256').update('validator-address').digest('hex').slice(0, 40)}`;
    const resolved = resolveDeployment({
      configDir,
      environment: 'local',
      fixtureRoot: path.join(root, 'fixtures/releases/0.4.2/packages'),
      profileDir,
      preferFixtures: true,
      deploymentPlanFile: planPath,
      approvedRootBindings: {
        protocolGenesisRoot: rootValue('genesis'),
        authorityStateRoot: rootValue('authority'),
        localAuthorityPolicyRoot: rootValue('policy'),
        initialConfigurationRoot: rootValue('configuration'),
        initialVerifierRegistryRoot: rootValue('registry'),
        authorityTransitionValidatorAddress: validatorAddress,
      },
    });
    const c1 = rootValue('successor-configuration');
    const c1Spec = bindStatementAdmissionSnapshot(resolved.spec, plan, c1, 1);
    expect(c1Spec.contracts['prf/statement-admission']!.constructorBindings).toMatchObject({
      expectedConfigurationRoot_: { kind: 'literal', value: c1 },
      expectedConfigurationEpoch_: { kind: 'literal', value: 1 },
    });
    expect(resolved.spec.contracts['prf/statement-admission']!.constructorBindings?.expectedConfigurationRoot_)
      .toEqual({ kind: 'literal', value: rootValue('configuration') });

    const malformed = structuredClone(plan);
    malformed.stages.find((stage) => stage.id === 'deploy-statement-admission')!.consumes.activeConfigurationEpoch = {
      stage: 'derive-successor-configuration', output: 'configurationEpoch',
    };
    expectCode(() => bindStatementAdmissionSnapshot(resolved.spec, malformed, c1, 1), 'PLAN_ADMISSION_SNAPSHOT_BINDING_INVALID');
  });

  it('rejects cyclic stage dependencies before topological-order validation', () => {
    const cyclic = structuredClone(plan);
    cyclic.stages.find((stage) => stage.id === 'deploy-local-token')!.dependsOn = ['derive-genesis-roots'];
    cyclic.stages.find((stage) => stage.id === 'derive-genesis-roots')!.dependsOn = ['deploy-local-token'];
    expectCode(() => validateSuccessorDeploymentPlan(cyclic), 'DEPLOYMENT_PLAN_STAGE_CYCLE');
  });

  it('derives initial configuration before deployment and uses only the empty registry root', () => {
    const stageIndex = new Map(plan.stages.map((stage, index) => [stage.id, index]));
    const initialRoots = plan.stages.find((stage) => stage.id === 'derive-genesis-roots')!;
    const deployAuthority = plan.stages.find((stage) => stage.id === 'deploy-authority-and-verifier')!;
    const deployToken = plan.stages.find((stage) => stage.id === 'deploy-local-token')!;
    const initialConfiguration = plan.stages.find((stage) => stage.id === 'derive-initial-configuration')!;
    const deriveSuccessorRegistry = plan.stages.find((stage) => stage.id === 'derive-registry-roots')!;
    const sealEmptyRegistry = plan.stages.find((stage) => stage.id === 'seal-empty-verifier-registry')!;
    const deployGenesis = plan.stages.find((stage) => stage.id === 'deploy-genesis')!;

    expect(stageIndex.get(initialRoots.id)).toBeLessThan(stageIndex.get(initialConfiguration.id)!);
    expect(stageIndex.get(initialConfiguration.id)).toBeLessThan(stageIndex.get(deployToken.id)!);
    expect(stageIndex.get(initialConfiguration.id)).toBeLessThan(stageIndex.get(deployAuthority.id)!);
    expect(stageIndex.get(initialConfiguration.id)).toBeLessThan(stageIndex.get(deployGenesis.id)!);
    expect(initialRoots.produces).toContain('emptyRegistryRoot');
    expect(initialRoots.produces).not.toContain('initialConfigurationRoot');
    expect(initialRoots.consumes).not.toHaveProperty('successorRegistryRoot');
    expect(initialConfiguration.produces).toContain('initialConfigurationRoot');
    expect(initialConfiguration.consumes.emptyRegistryRoot).toEqual({
      stage: 'derive-genesis-roots', output: 'emptyRegistryRoot',
    });
    expect(initialConfiguration.dependsOn).toEqual(['derive-genesis-roots']);
    expect(initialConfiguration.consumes).toEqual({
      protocolGenesisRoot: { stage: 'derive-genesis-roots', output: 'protocolGenesisRoot' },
      emptyRegistryRoot: { stage: 'derive-genesis-roots', output: 'emptyRegistryRoot' },
    });
    expect(initialConfiguration.consumes).not.toHaveProperty('successorRegistryRoot');
    expect(deriveSuccessorRegistry.produces).toEqual(['successorRegistryRoot']);
    expect(sealEmptyRegistry.consumes.emptyRegistryRoot).toEqual({
      stage: 'derive-genesis-roots', output: 'emptyRegistryRoot',
    });
    expect(deployGenesis.consumes.initialConfigurationRoot).toEqual({
      stage: 'derive-initial-configuration', output: 'initialConfigurationRoot',
    });
  });

  it('rejects missing or substituted predeployment roots', () => {
    const missing = structuredClone(plan);
    const initial = missing.stages.find((stage) => stage.id === 'derive-initial-configuration')!;
    delete initial.consumes.emptyRegistryRoot;
    expectCode(() => validateSuccessorDeploymentPlan(missing), 'DEPLOYMENT_PLAN_STAGE_OUTPUT');

    const substituted = structuredClone(plan);
    const initialSubstituted = substituted.stages.find((stage) => stage.id === 'derive-initial-configuration')!;
    initialSubstituted.consumes.emptyRegistryRoot = { stage: 'derive-genesis-roots', output: 'protocolGenesisRoot' };
    expectCode(() => validateSuccessorDeploymentPlan(substituted), 'DEPLOYMENT_PLAN_STAGE_OUTPUT');

    const wrongGenesisInput = structuredClone(plan);
    wrongGenesisInput.stages.find((stage) => stage.id === 'deploy-genesis')!.consumes.authorityStateRoot = {
      stage: 'derive-initial-configuration', output: 'initialConfigurationRoot',
    };
    expectCode(() => validateSuccessorDeploymentPlan(wrongGenesisInput), 'DEPLOYMENT_PLAN_STAGE_OUTPUT');

    const deploymentBeforeInitial = structuredClone(plan);
    const initialIndex = deploymentBeforeInitial.stages.findIndex((stage) => stage.id === 'derive-initial-configuration');
    const tokenIndex = deploymentBeforeInitial.stages.findIndex((stage) => stage.id === 'deploy-local-token');
    [deploymentBeforeInitial.stages[initialIndex], deploymentBeforeInitial.stages[tokenIndex]] =
      [deploymentBeforeInitial.stages[tokenIndex]!, deploymentBeforeInitial.stages[initialIndex]!];
    expectCode(() => validateSuccessorDeploymentPlan(deploymentBeforeInitial), 'DEPLOYMENT_PLAN_INITIAL_CONFIGURATION_ORDER');
  });

  it('keeps structural validation separate from deployment execution availability', () => {
    expect(() => validateSuccessorDeploymentPlan(plan)).not.toThrow();
    expect(unsupportedDeploymentPrerequisite(plan)).toEqual({ contract: 'prf/statement-admission', stage: 'authorize-successor-configuration' });
    expectCode(() => assertPlanDeployable(plan), 'PLAN_STAGE_EXECUTOR_UNAVAILABLE');
  });

  it('records PRF-owned genesis derivations without promoting candidate semantic inputs', () => {
    const graph = JSON.parse(fs.readFileSync(path.join(root, 'config/pro-rata-v2-entitlement/genesis-dependency-graph.v1.json'), 'utf8')) as {
      schema: string;
      qualification: string;
      roots: Array<{ id: string; producer: string; artifactStatus: string; inputs: string[]; availableAt?: string; deploymentDependency?: boolean }>;
      cycleAssessment: string;
    };
    const byId = new Map(graph.roots.map((entry) => [entry.id, entry]));
    expect(graph.schema).toBe('prf-successor-genesis-dependency-graph.v1');
    expect(graph.qualification).toBe('candidate-map-only');
    expect(byId.get('protocolGenesisRoot')!.producer).toBe('resolver-sim.genesis/protocol-genesis-root');
    expect(byId.get('protocolGenesisRoot')!.artifactStatus).toContain('requires-owner-approval');
    expect(byId.get('authorityStateRoot')!.artifactStatus).toContain('missing-semantic-definition');
    expect(byId.get('initialConfigurationRoot')!.inputs).toContain('verifier-registry/root = emptyRegistryRoot');
    expect(byId.get('initialConfigurationRoot')!.availableAt).toContain('before deployment');
    expect(byId.get('initialConfigurationRoot')!.deploymentDependency).toBe(false);
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

  it('projects stage-output dependencies only from explicit receipt-bound values and keeps releases fail-closed', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const config = loadConfig({ configDir, profileDir });
    const environment = loadEnvironment(configDir, 'local', profileDir);
    const stageOutput = structuredClone(plan);
    stageOutput.contracts['prf/source-bound-entitlement-verifier-adapter-v1'] = {
      kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier', output: 'successorAdapter',
    };
    stageOutput.stages.find((stage) => stage.id === 'deploy-authority-and-verifier')!.dependsOn = ['deploy-local-token'];
    expectCode(() => projectConfigurationForPlan(config, environment, stageOutput), 'PLAN_STAGE_OUTPUT_UNRESOLVED');
    const projected = projectConfigurationForPlan(config, environment, stageOutput, {
      stageOutputValues: { 'prf/source-bound-entitlement-verifier-adapter-v1': { address: `0x${'55'.repeat(20)}` } },
    });
    expect(projected.deployedLogicalIds).not.toContain('prf/source-bound-entitlement-verifier-adapter-v1');
    expect(projected.consumedStageOutputIds).toEqual(['prf/source-bound-entitlement-verifier-adapter-v1']);
    expect(projected.environment.externalContracts?.['prf/source-bound-entitlement-verifier-adapter-v1']?.address).toBe(`0x${'55'.repeat(20)}`);
    const admitted = structuredClone(plan);
    admitted.contracts['prf/sp1-verifier-groth16'] = {
      kind: 'admitted-release', unit: 'prf-assurance', releaseId: 'missing-release', logicalId: 'sp1-verifier-groth16',
    };
    expectCode(() => projectConfigurationForPlan(config, environment, admitted), 'PLAN_ADMITTED_RELEASE_UNSUPPORTED');
  });

  it('requires every downstream consumer to depend on the stage-output producer stage', () => {
    const configDir = path.join(root, 'config');
    const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
    const config = loadConfig({ configDir, profileDir });
    const environment = loadEnvironment(configDir, 'local', profileDir);
    const stageOutput = structuredClone(plan);
    stageOutput.contracts['prf/sp1-verifier-groth16'] = {
      kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-local-token', output: 'localToken',
    };
    expectCode(() => projectConfigurationForPlan(config, environment, stageOutput, {
      stageOutputValues: { 'prf/sp1-verifier-groth16': { address: `0x${'55'.repeat(20)}` } },
    }), 'PLAN_STAGE_OUTPUT_ORDER');
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
      executionStatus: 'partial',
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
            const outputName = Object.entries(stage.contractOutputs ?? {}).find(([, mappedId]) => mappedId === logicalId)?.[0] ?? logicalId;
            return [outputName, { address: fact.address, transactionHash: fact.deploymentTx, blockNumber: fact.blockNumber, runtimeBytecodeSha256: fact.artifact.runtimeBytecodeSha256 }];
          })),
        };
      }),
    };
    const receipt = { ...body, planExecutionRoot: planExecutionRoot(body) };
    expect(() => assertPlanExecutionMatchesManifest(receipt, plan, manifest)).not.toThrow();
    const reseal = (value: Record<string, unknown>) => {
      const { planExecutionRoot: _old, ...valueBody } = value;
      value.planExecutionRoot = planExecutionRoot(valueBody);
      return value;
    };
    const prefixManifest = { ...manifest, finalAssertions: [{ id: 'plan-execution-prefix', status: 'passed' as const, verifiedAt: 'now', detail: JSON.stringify({ executionStatus: 'partial', blockedStages: [] }) }] };
    const prefixReceipt = reseal({ ...structuredClone(receipt), manifestRoot: computeManifestRoot(prefixManifest) });
    expectCode(() => assertPlanExecutionMatchesManifest(prefixReceipt, plan, prefixManifest), 'PLAN_EXECUTION_PREFIX_MISMATCH');

    const address = (logicalId: string) => manifest.contracts.find((contract) => contract.logicalId === logicalId)!.address;
    const approval = { manifestRoot: 'sha256:' + 'a'.repeat(64), approvedRootBindings: {
      localAuthorityPolicyRoot: '0x' + '1'.repeat(64), authorityStateRoot: '0x' + '2'.repeat(64),
      authorityTransitionValidatorAddress: address('prf/authority-transition-validator'),
    } };
    const enablement = {
      schema: 'prf-authority-transition-enable-preflight.v1', manifestRoot: approval.manifestRoot,
      localAuthorityPolicyRoot: approval.approvedRootBindings.localAuthorityPolicyRoot,
      initialAuthorityStateRoot: approval.approvedRootBindings.authorityStateRoot,
      genesisAddress: address('prf/genesis'), deployedValidatorAddress: address('prf/authority-transition-validator'),
      transitionValidatorAddress: address('prf/authority-transition-validator'), enabledBefore: false, enabledAfter: true,
      transactionHash: '0x' + '5'.repeat(64), blockNumber: '2',
    };
    const authorityManifest = { ...manifest,
      bootstrapActions: [{ id: 'prf/enable-authority-transitions', status: 'verified' as const, transactionHash: enablement.transactionHash as `0x${string}`, blockNumber: enablement.blockNumber }],
      finalAssertions: [
        { id: 'prf-initial-input-approval', status: 'passed' as const, verifiedAt: 'now', detail: JSON.stringify(approval) },
        { id: 'prf-authority-transition-enablement', status: 'passed' as const, verifiedAt: 'now', detail: JSON.stringify({ ...enablement, enabledAfter: false }) },
      ],
    };
    const authorityReceipt = reseal({ ...structuredClone(receipt), manifestRoot: computeManifestRoot(authorityManifest) });
    expectCode(() => assertPlanExecutionMatchesManifest(authorityReceipt, plan, authorityManifest), 'PLAN_EXECUTION_AUTHORITY_ENABLEMENT_MISMATCH');
    const dependencyViolation = structuredClone(receipt);
    dependencyViolation.stages.find((stage) => stage.id === 'deploy-genesis')!.status = 'verified';
    const { planExecutionRoot: _oldRoot, ...dependencyBody } = dependencyViolation;
    dependencyViolation.planExecutionRoot = planExecutionRoot(dependencyBody);
    expectCode(() => assertPlanExecutionMatchesManifest(dependencyViolation, plan, manifest), 'PLAN_EXECUTION_STAGE_DEPENDENCY_MISMATCH');
    const substituted = { ...manifest, contracts: manifest.contracts.slice(1) };
    expectCode(() => assertPlanExecutionMatchesManifest(receipt, plan, substituted), 'PLAN_EXECUTION_MANIFEST_MISMATCH');
    const wrongChain = reseal({ ...structuredClone(receipt), chainId: 1 });
    expectCode(() => assertPlanExecutionMatchesManifest(wrongChain, plan, manifest), 'PLAN_EXECUTION_CONTEXT_MISMATCH');
    const unknownStageStatus = structuredClone(receipt) as Record<string, unknown>;
    (unknownStageStatus.stages as Array<{ status: string }>)[0]!.status = 'succeeded';
    expectCode(() => assertPlanExecutionMatchesManifest(reseal(unknownStageStatus), plan, manifest), 'PLAN_EXECUTION_STATUS_INVALID');
    const notApplicableDeploymentStage = structuredClone(receipt) as Record<string, unknown>;
    const nonExternalStage = plan.stages.findIndex((stage) => stage.kind !== 'external-preflight');
    (notApplicableDeploymentStage.stages as Array<{ status: string }>)[nonExternalStage]!.status = 'not-applicable';
    expectCode(() => assertPlanExecutionMatchesManifest(reseal(notApplicableDeploymentStage), plan, manifest), 'PLAN_EXECUTION_STATUS_INVALID');
    const incompleteComplete = reseal({ ...structuredClone(receipt), executionStatus: 'complete' });
    expectCode(() => assertPlanExecutionMatchesManifest(incompleteComplete, plan, manifest), 'PLAN_EXECUTION_STATUS_INVALID');
  });

  it('independently checks the retained successor derivation output and sole C0 to C1 change', () => {
    const fixture = structuredClone(plan);
    fixture.contracts = {};
    fixture.stages = [{ id: 'derive-successor-configuration', kind: 'derive-canonical-roots', dependsOn: [], consumes: {},
      produces: ['decisionRoot', 'successorConfigurationRoot', 'configurationEpoch', 'targetRoot'] }];
    fixture.verifierClosures = [];
    const c0 = `sha256:${'1'.repeat(64)}`;
    const c1 = `sha256:${'2'.repeat(64)}`;
    const registry = `sha256:${'3'.repeat(64)}`;
    const decision = `sha256:${'4'.repeat(64)}`;
    const instance = `sha256:${'5'.repeat(64)}`;
    const derivation = {
      schema: 'prf-successor-configuration-derivation.v1',
      qualification: 'derived-only-not-approved',
      'protocol-genesis-root': `sha256:${'6'.repeat(64)}`,
      'chain-instance-genesis': { instance: 'test' },
      'chain-instance-genesis-root': instance,
      'configuration/C0': { 'configuration/schema': 'chain-configuration.v1' },
      'configuration/C0-root': c0,
      'configuration/C1-root': c1,
      'changed-fields': ['verifier-registry/root'],
      'successor-verifier-registry-root': registry,
      'successor-proof-mode': 1,
      'decision-root': decision,
      'configuration-transition': {
        epoch: 1, 'configuration/parent-root': c0, 'configuration/new-root': c1,
        'verifier-registry/root': registry, target: { 'target/root': instance },
      },
    };
    const output = JSON.stringify(derivation);
    const request = {
      'initial-configuration': derivation['configuration/C0'],
      'protocol-genesis-root': derivation['protocol-genesis-root'],
      'chain-instance-genesis': derivation['chain-instance-genesis'],
      'expected-chain-instance-genesis-root': derivation['chain-instance-genesis-root'],
      'expected-initial-configuration-root': derivation['configuration/C0-root'],
      'successor-verifier-registry-root': derivation['successor-verifier-registry-root'],
      'successor-proof-mode': derivation['successor-proof-mode'],
      epoch: 1,
    };
    const requestSha256 = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const evidence = {
      schema: 'prf-successor-configuration-evidence.v1',
      qualification: 'successor-configuration-independently-derived-not-approved',
      request, requestSha256, outputSha256: createHash('sha256').update(output).digest('hex'), output, derivation,
    };
    const manifest: DeploymentManifestV1 = {
      type: 'protocol-deployment-manifest/v1', architectureSpecHash: '0x01', executionSpecHash: '0x02', deploymentId: 'test-run',
      chain: { id: 31337, blockNumber: '1', blockHash: `0x${'11'.repeat(32)}` as `0x${string}` },
      deployer: `0x${'22'.repeat(20)}` as `0x${string}`, contracts: [], bootstrapActions: [],
      finalAssertions: [{ id: 'prf-successor-configuration-derivation', status: 'passed', verifiedAt: '2026-01-01T00:00:00.000Z', detail: JSON.stringify(evidence) }],
    };
    const stageEvidence = { type: 'prf-successor-configuration-derivation', requestSha256: evidence.requestSha256,
      verifierOutputSha256: evidence.outputSha256, qualification: evidence.qualification };
    const stageOutputs = { decisionRoot: decision, successorConfigurationRoot: c1, configurationEpoch: 1, targetRoot: instance };
    const body = {
      type: 'protocol-deployment-plan-execution/v1', executionStatus: 'complete', planId: fixture.planId,
      planHash: deploymentPlanHash(fixture), environment: 'local', chainId: 31337, localOnly: true,
      selectedUnits: fixture.selectedUnits, excludedUnits: fixture.excludedUnits, selectedContracts: [],
      manifestRoot: computeManifestRoot(manifest), stageOutputBindings: [],
      stages: [{ id: 'derive-successor-configuration', kind: 'derive-canonical-roots', status: 'verified', outputs: stageOutputs, evidence: stageEvidence }],
    };
    const receipt = { ...body, planExecutionRoot: planExecutionRoot(body) };
    expect(() => assertPlanExecutionMatchesManifest(receipt, fixture, manifest)).not.toThrow();
    const substituted = structuredClone(receipt);
    substituted.stages[0]!.outputs.successorConfigurationRoot = `sha256:${'9'.repeat(64)}`;
    const { planExecutionRoot: _oldRoot, ...substitutedBody } = substituted;
    substituted.planExecutionRoot = planExecutionRoot(substitutedBody);
    expectCode(() => assertPlanExecutionMatchesManifest(substituted, fixture, manifest), 'PLAN_EXECUTION_SUCCESSOR_DERIVATION_MISMATCH');
  });

  it('independently checks C1 application against its approved derivation, registry seal and consumed decision', () => {
    const fixture = structuredClone(plan);
    fixture.contracts = {};
    fixture.stages = [{ id: 'apply-successor-configuration', kind: 'authorize-configuration', dependsOn: [], consumes: {},
      produces: ['activeConfigurationRoot', 'activeConfigurationEpoch', 'activeEntitlementProofMode', 'configurationTransitionReceipt'] }];
    fixture.verifierClosures = [];
    const decisionRoot = `0x${'1'.repeat(64)}`;
    const configurationRoot = `0x${'2'.repeat(64)}`;
    const verifierRegistryRoot = `0x${'3'.repeat(64)}`;
    const manifestRoot = `sha256:${'4'.repeat(64)}`;
    const transactionHash = `0x${'5'.repeat(64)}`;
    const blockNumber = '42';
    const transitionApproval = { manifestRoot };
    const evidence = {
      decisionRoot, configurationRoot, verifierRegistryRoot, epoch: 1, entitlementProofMode: fixture.successorProofMode,
      consumed: true, transactionHash, blockNumber, transitionApproval: JSON.stringify(transitionApproval),
    };
    const manifest: DeploymentManifestV1 = {
      type: 'protocol-deployment-manifest/v1', architectureSpecHash: '0x01', executionSpecHash: '0x02', deploymentId: 'test-run',
      chain: { id: 31337, blockNumber: '50', blockHash: `0x${'11'.repeat(32)}` as `0x${string}` },
      deployer: `0x${'22'.repeat(20)}` as `0x${string}`, contracts: [],
      bootstrapActions: [{ id: 'prf/apply-successor-configuration', status: 'verified', transactionHash: transactionHash as `0x${string}`, blockNumber }],
      finalAssertions: [
        { id: 'prf-successor-configuration-application', status: 'passed', verifiedAt: '2026-01-01T00:00:00.000Z', detail: JSON.stringify(evidence) },
        { id: 'prf-successor-configuration-derivation', status: 'passed', verifiedAt: '2026-01-01T00:00:00.000Z', detail: JSON.stringify({ derivation: {
          'configuration/C1-root': `sha256:${configurationRoot.slice(2)}`,
          'successor-verifier-registry-root': `sha256:${verifierRegistryRoot.slice(2)}`,
          'decision-root': `sha256:${decisionRoot.slice(2)}`,
        } }) },
        { id: 'prf-successor-transition-approval', status: 'passed', verifiedAt: '2026-01-01T00:00:00.000Z', detail: JSON.stringify({ manifestRoot }) },
        { id: 'prf-successor-verifier-registry-seal', status: 'passed', verifiedAt: '2026-01-01T00:00:00.000Z', detail: JSON.stringify({
          registryRoot: verifierRegistryRoot, approvalManifestRoot: manifestRoot,
        }) },
      ],
    };
    const stageEvidence = { type: 'prf-successor-configuration-application', decisionRoot, configurationRoot,
      verifierRegistryRoot, epoch: 1, entitlementProofMode: fixture.successorProofMode, consumed: true };
    const body = {
      type: 'protocol-deployment-plan-execution/v1', executionStatus: 'complete', planId: fixture.planId,
      planHash: deploymentPlanHash(fixture), environment: 'local', chainId: 31337, localOnly: true,
      selectedUnits: fixture.selectedUnits, excludedUnits: fixture.excludedUnits, selectedContracts: [],
      manifestRoot: computeManifestRoot(manifest), stageOutputBindings: [],
      stages: [{ id: 'apply-successor-configuration', kind: 'authorize-configuration', status: 'verified',
        outputs: { configurationTransitionReceipt: { transactionHash, blockNumber }, activeConfigurationRoot: configurationRoot,
          activeConfigurationEpoch: 1, activeEntitlementProofMode: fixture.successorProofMode }, evidence: stageEvidence }],
    };
    const receipt = { ...body, planExecutionRoot: planExecutionRoot(body) };
    expect(() => assertPlanExecutionMatchesManifest(receipt, fixture, manifest)).not.toThrow();
    const substituted = structuredClone(receipt);
    substituted.stages[0]!.outputs.activeConfigurationRoot = `0x${'9'.repeat(64)}`;
    const { planExecutionRoot: _oldRoot, ...substitutedBody } = substituted;
    substituted.planExecutionRoot = planExecutionRoot(substitutedBody);
    expectCode(() => assertPlanExecutionMatchesManifest(substituted, fixture, manifest), 'PLAN_EXECUTION_SUCCESSOR_CONFIGURATION_MISMATCH');
  });

  it('requires partial registry derivation receipts to bind PRF output, Solidity equality and the manifest assertion', () => {
    const fixture = structuredClone(plan);
    fixture.contracts = {};
    fixture.stages = [{ id: 'derive-registry-roots', kind: 'derive-canonical-roots', dependsOn: [], consumes: {}, produces: ['successorRegistryRoot'] }];
    fixture.verifierClosures = [];
    const entry = {
      id: `0x${'01'.repeat(32)}`, adapter: `0x${'02'.repeat(20)}`, programVKey: `0x${'03'.repeat(32)}`,
      programElfSha256: `0x${'04'.repeat(32)}`, programId: 'program.v1', statementSchemaVersionHash: `0x${'05'.repeat(32)}`,
      publicValuesSchema: `0x${'06'.repeat(32)}`, active: true,
    };
    const root = `0x${'07'.repeat(32)}`;
    const output = JSON.stringify({ schema: 'prf-verifier-registry-derivation-result.v1', root, entries: [entry] });
    const requestSha256 = createHash('sha256').update(JSON.stringify({ schema: 'prf-verifier-registry-derivation-request.v1', entries: [entry] })).digest('hex');
    const outputSha256 = createHash('sha256').update(output, 'utf8').digest('hex');
    const evidence = {
      schema: 'prf-verifier-registry-derivation-evidence.v1', qualification: 'canonical-root-derived-and-solidity-equivalent',
      root, entry, observationBlock: { number: '123', hash: `0x${'08'.repeat(32)}` }, solidityRoot: root,
      requestSha256, outputSha256, output, verifierCommand: ['clojure'],
    };
    const manifest: DeploymentManifestV1 = {
      type: 'protocol-deployment-manifest/v1', architectureSpecHash: '0x01', executionSpecHash: '0x02', deploymentId: 'partial-run',
      chain: { id: 31337, blockNumber: '123', blockHash: `0x${'08'.repeat(32)}` }, deployer: `0x${'09'.repeat(20)}`,
      contracts: [], bootstrapActions: [],
      finalAssertions: [{ id: 'prf-successor-registry-derivation', status: 'passed', verifiedAt: '2026-01-01T00:00:00.000Z', detail: JSON.stringify(evidence) }],
    };
    const body = {
      type: 'protocol-deployment-plan-execution/v1', executionStatus: 'partial', planId: fixture.planId,
      planHash: deploymentPlanHash(fixture), environment: 'test', chainId: 31337, localOnly: true,
      selectedUnits: fixture.selectedUnits, excludedUnits: fixture.excludedUnits, selectedContracts: [],
      manifestRoot: computeManifestRoot(manifest),
      stages: [{ id: 'derive-registry-roots', kind: 'derive-canonical-roots', status: 'verified', outputs: { successorRegistryRoot: root }, evidence }],
    };
    const receipt = { ...body, planExecutionRoot: planExecutionRoot(body) };
    expect(() => assertPlanExecutionMatchesManifest(receipt, fixture, manifest)).not.toThrow();
    const substituted = structuredClone(receipt);
    substituted.stages[0]!.outputs.successorRegistryRoot = `0x${'0a'.repeat(32)}`;
    const { planExecutionRoot: _root, ...substitutedBody } = substituted;
    substituted.planExecutionRoot = planExecutionRoot(substitutedBody);
    expectCode(() => assertPlanExecutionMatchesManifest(substituted, fixture, manifest), 'PLAN_EXECUTION_REGISTRY_DERIVATION_MISMATCH');
  });

  it('binds stage-output receipt roots and addresses into plan-execution evidence', () => {
    const fixture = structuredClone(plan);
    fixture.contracts = {
      'prf/local-token': structuredClone(plan.contracts['prf/local-token']!),
      'prf/sp1-verifier-groth16': { kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier', output: 'sp1Verifier' },
    };
    fixture.authorizedConfigurationActions = [];
    const localContract = {
      logicalId: 'prf/local-token',
      address: `0x${'33'.repeat(20)}` as `0x${string}`,
      artifact: { source: 'fixture', package: 'fixture', version: '1', artifactName: 'LocalToken', abiSha256: '11'.repeat(32), creationBytecodeSha256: '22'.repeat(32), runtimeBytecodeSha256: '33'.repeat(32) },
      deploymentTx: `0x${'44'.repeat(32)}` as `0x${string}`,
      blockNumber: '1',
    };
    const stageOutputArtifact = { source: 'prf', package: 'prf', version: '1', artifactName: 'SP1VerifierGroth16', abiSha256: 'aa'.repeat(32), creationBytecodeSha256: 'bb'.repeat(32), runtimeBytecodeSha256: 'cc'.repeat(32) };
    const manifest: DeploymentManifestV2 = {
      type: 'protocol-deployment-manifest/v2', architectureSpecHash: '0x01', executionSpecHash: '0x02', deploymentId: 'test-run',
      chain: { id: 31337, blockNumber: '2', blockHash: `0x${'12'.repeat(32)}` as `0x${string}` },
      deployer: `0x${'22'.repeat(20)}` as `0x${string}`,
      contracts: [localContract], bootstrapActions: [], finalAssertions: [],
      externalContracts: [{
        logicalId: 'prf/sp1-verifier-groth16', address: `0x${'55'.repeat(20)}` as `0x${string}`,
        artifact: stageOutputArtifact, observedRuntimeCodeKeccak256: `0x${'66'.repeat(32)}`,
        observedAt: { blockNumber: '2', blockHash: `0x${'12'.repeat(32)}` as `0x${string}` },
      }],
    };
    const statuses = new Map<string, string>();
    const body = {
      type: 'protocol-deployment-plan-execution/v1', executionStatus: 'partial', planId: fixture.planId, planHash: deploymentPlanHash(fixture),
      environment: 'local', chainId: 31337, localOnly: true, selectedUnits: fixture.selectedUnits, excludedUnits: fixture.excludedUnits,
      selectedContracts: Object.entries(fixture.contracts).map(([logicalId, source]) => ({ logicalId, ...source })),
      manifestRoot: computeManifestRoot(manifest),
      stageOutputBindings: [{ logicalId: 'prf/sp1-verifier-groth16', stage: 'deploy-authority-and-verifier', output: 'sp1Verifier', receiptRoot: `0x${'77'.repeat(32)}`, outputRoot: `0x${'88'.repeat(32)}`, address: `0x${'55'.repeat(20)}` }],
      stages: fixture.stages.map((stage) => {
        const prerequisitesSatisfied = stage.dependsOn.every((dependency) => ['verified', 'not-applicable'].includes(statuses.get(dependency) ?? ''));
        const isLocalTokenStage = stage.id === 'deploy-local-token';
        const status = isLocalTokenStage ? 'verified' : stage.kind === 'external-preflight' ? 'not-applicable' : 'not-executed';
        statuses.set(stage.id, status);
        return isLocalTokenStage
          ? { id: stage.id, kind: stage.kind, status, outputs: { localToken: { address: localContract.address, transactionHash: localContract.deploymentTx, blockNumber: '1', runtimeBytecodeSha256: localContract.artifact.runtimeBytecodeSha256 } } }
          : { id: stage.id, kind: stage.kind, status: prerequisitesSatisfied ? status : 'blocked' };
      }),
    };
    const receipt = { ...body, planExecutionRoot: planExecutionRoot(body) };
    expect(() => assertPlanExecutionMatchesManifest(receipt, fixture, manifest)).not.toThrow();

    const crossPlan = structuredClone(fixture);
    (crossPlan.contracts['prf/sp1-verifier-groth16'] as Extract<typeof crossPlan.contracts[string], { kind: 'stage-output' }>).producer = {
      planId: 'prf/controlled-shortfall-successor-fork.v1', planHash: `0x${'01'.repeat(32)}`,
      executionRoot: `0x${'02'.repeat(32)}`, manifestRoot: `0x${'03'.repeat(32)}`, verificationRoot: `0x${'04'.repeat(32)}`,
      evidenceRoot: `0x${'05'.repeat(32)}`, outputRoot: `0x${'88'.repeat(32)}`, address: `0x${'55'.repeat(20)}`,
    };
    const crossBody = {
      ...body,
      planHash: deploymentPlanHash(crossPlan),
      selectedContracts: Object.entries(crossPlan.contracts).map(([logicalId, source]) => ({ logicalId, ...source })),
      stageOutputBindings: [{ logicalId: 'prf/sp1-verifier-groth16', stage: 'deploy-authority-and-verifier', output: 'sp1Verifier', evidenceRoot: `0x${'05'.repeat(32)}`, outputRoot: `0x${'88'.repeat(32)}`, address: `0x${'55'.repeat(20)}` }],
    };
    const crossReceipt = { ...crossBody, planExecutionRoot: planExecutionRoot(crossBody) };
    expect(() => assertPlanExecutionMatchesManifest(crossReceipt, crossPlan, manifest)).not.toThrow();
    const mislabeledEvidence = structuredClone(crossReceipt);
    const mislabeledBinding = mislabeledEvidence.stageOutputBindings[0] as Record<string, unknown>;
    mislabeledBinding.receiptRoot = `0x${'05'.repeat(32)}`;
    delete mislabeledBinding.evidenceRoot;
    const { planExecutionRoot: _mislabeledRoot, ...mislabeledBody } = mislabeledEvidence;
    mislabeledEvidence.planExecutionRoot = planExecutionRoot(mislabeledBody);
    expectCode(() => assertPlanExecutionMatchesManifest(mislabeledEvidence, crossPlan, manifest), 'PLAN_EXECUTION_STAGE_OUTPUTS_MISMATCH');

    const { stageOutputBindings: _omittedBindings, planExecutionRoot: _missingRoot, ...missingBody } = structuredClone(receipt);
    const missing = { ...missingBody, planExecutionRoot: planExecutionRoot(missingBody) };
    expectCode(() => assertPlanExecutionMatchesManifest(missing, fixture, manifest), 'PLAN_EXECUTION_STAGE_OUTPUTS_MISSING');

    const substituted = structuredClone(receipt);
    substituted.stageOutputBindings[0]!.address = `0x${'99'.repeat(20)}`;
    const { planExecutionRoot: _substitutedRoot, ...substitutedBody } = substituted;
    substituted.planExecutionRoot = planExecutionRoot(substitutedBody);
    expectCode(() => assertPlanExecutionMatchesManifest(substituted, fixture, manifest), 'PLAN_EXECUTION_STAGE_OUTPUT_MANIFEST_MISMATCH');

    const malformedCommitment = structuredClone(receipt);
    malformedCommitment.stageOutputBindings[0]!.outputRoot = 'not-a-root';
    const { planExecutionRoot: _malformedRoot, ...malformedBody } = malformedCommitment;
    malformedCommitment.planExecutionRoot = planExecutionRoot(malformedBody);
    expectCode(() => assertPlanExecutionMatchesManifest(malformedCommitment, fixture, manifest), 'PLAN_EXECUTION_STAGE_OUTPUTS_MISMATCH');

    const undeclared = structuredClone(fixture);
    undeclared.contracts['prf/sp1-verifier-groth16'] = { kind: 'external', unit: 'prf-assurance' } as typeof undeclared.contracts[string];
    const unexpected = structuredClone(receipt);
    unexpected.planId = undeclared.planId;
    unexpected.planHash = deploymentPlanHash(undeclared);
    unexpected.selectedContracts = Object.entries(undeclared.contracts).map(([logicalId, source]) => ({ logicalId, ...source }));
    const { planExecutionRoot: _unexpectedRoot, ...unexpectedBody } = unexpected;
    unexpected.planExecutionRoot = planExecutionRoot(unexpectedBody);
    expectCode(() => assertPlanExecutionMatchesManifest(unexpected, undeclared, manifest), 'PLAN_EXECUTION_STAGE_OUTPUTS_UNEXPECTED');
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
    fixture.stages.find((stage) => stage.id === 'deploy-local-token')!.dependsOn = ['deploy-genesis'];
    expectCode(() => validateSuccessorDeploymentPlan(fixture), 'DEPLOYMENT_PLAN_STAGE_ORDER');
    const missingOutput = structuredClone(plan);
    const registryRoots = missingOutput.stages.find((stage) => stage.id === 'derive-registry-roots')!;
    registryRoots.dependsOn.push('deploy-local-token');
    registryRoots.consumes.notARealFact = { stage: 'deploy-local-token', output: 'notARealFact' };
    expectCode(() => validateSuccessorDeploymentPlan(missingOutput), 'DEPLOYMENT_PLAN_STAGE_OUTPUT');
  });

  it('rejects a contract output mapped to a contract from another stage', () => {
    const mismatched = structuredClone(plan);
    mismatched.stages.find((stage) => stage.id === 'deploy-local-token')!.contractOutputs = { localToken: 'prf/sp1-verifier-groth16' };
    expectCode(() => validateSuccessorDeploymentPlan(mismatched), 'DEPLOYMENT_PLAN_CONTRACT_OUTPUT');
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
    undeclared.stages.find((stage) => stage.id === 'derive-registry-roots')!.consumes.chain = {
      stage: 'deploy-local-token', output: 'chainId',
    };
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
