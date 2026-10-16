import * as fs from 'fs';
import { z } from 'zod';
import { ConfigError } from '../errors';
import type { LoadedConfig } from '../config/load';
import type { RawEnvironment } from '../config/raw-types';
import { deploymentPlanHash } from './plan-execution';

const valueRefSchema = z.object({ stage: z.string().min(1), output: z.string().min(1) }).strict();
const producerIdentitySchema = z.object({
  planId: z.string().min(1),
  planHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  executionRoot: z.string().regex(/^0x[0-9a-f]{64}$/),
  manifestRoot: z.string().regex(/^0x[0-9a-f]{64}$/),
  verificationRoot: z.string().regex(/^0x[0-9a-f]{64}$/),
  evidenceRoot: z.string().regex(/^0x[0-9a-f]{64}$/),
  outputRoot: z.string().regex(/^0x[0-9a-f]{64}$/),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
}).strict();
const stageSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['external-preflight', 'deploy', 'derive-canonical-roots', 'authorize-configuration', 'seal-genesis', 'verify', 'proof-admission', 'protected-execution', 'entitlement-execution', 'reconcile']),
  dependsOn: z.array(z.string()),
  consumes: z.record(z.string(), valueRefSchema).default({}),
  produces: z.array(z.string()),
  contractOutputs: z.record(z.string(), z.string().min(1)).optional(),
}).strict();

const contractSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deploy'), unit: z.string().min(1), stage: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('external'), unit: z.string().min(1), dependencyId: z.string().min(1), stage: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('stage-output'), unit: z.string().min(1), stage: z.string().min(1), output: z.string().min(1), producer: producerIdentitySchema.optional() }).strict(),
  z.object({ kind: z.literal('admitted-release'), unit: z.string().min(1), releaseId: z.string().min(1), logicalId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('local-fixture'), unit: z.string().min(1), fixtureId: z.string().min(1), stage: z.string().min(1) }).strict(),
]);

const dependencyKindSchema = z.enum([
  'artifact-build', 'constructor', 'external-contract',
  'configuration-authorization', 'runtime-operational', 'local-fixture',
]);
const unitCatalogSchema = z.object({
  schema: z.literal('protocol-deployment-units.v1'),
  units: z.record(z.string().min(1), z.object({
    contracts: z.record(z.string().min(1), z.object({
      kind: z.enum(['artifact-build', 'external-contract', 'local-fixture']),
      dependencies: z.array(dependencyKindSchema),
    }).strict()),
  }).strict()),
}).strict();

export type DeploymentUnitCatalogV1 = z.infer<typeof unitCatalogSchema>;

export const successorDeploymentPlanSchema = z.object({
  schema: z.literal('protocol-deployment-plan.v1'),
  planId: z.literal('prf/controlled-shortfall-successor-fork.v1'),
  localOnly: z.boolean(),
  selectedUnits: z.array(z.enum(['sew-protocol', 'prf-assurance', 'protected-operations', 'pro-rata-successor-entitlements'])),
  excludedUnits: z.array(z.enum(['sew-protocol', 'prf-assurance', 'protected-operations', 'pro-rata-successor-entitlements'])),
  contracts: z.record(z.string(), contractSourceSchema),
  authorizedConfigurationActions: z.array(z.object({
    id: z.string().min(1), stage: z.string().min(1), target: z.string().min(1), function: z.string().min(1),
  }).strict()),
  stages: z.array(stageSchema).min(1),
}).strict();

export type SuccessorDeploymentPlanV1 = z.infer<typeof successorDeploymentPlanSchema>;

export function readSuccessorDeploymentPlan(file: string): SuccessorDeploymentPlanV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError('DEPLOYMENT_PLAN_UNREADABLE', `Cannot read deployment plan '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = successorDeploymentPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError('DEPLOYMENT_PLAN_INVALID', 'Successor deployment plan failed schema validation', { path: file, details: { issues: parsed.error.issues } });
  }
  validateSuccessorDeploymentPlan(parsed.data);
  return parsed.data;
}

export function readDeploymentUnitCatalog(file: string): DeploymentUnitCatalogV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError('DEPLOYMENT_UNITS_UNREADABLE', `Cannot read deployment units '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = unitCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError('DEPLOYMENT_UNITS_INVALID', 'Deployment unit catalog failed schema validation', { path: file, details: { issues: parsed.error.issues } });
  }
  return parsed.data;
}

/** Check that a plan only selects contracts from selected units and that each
 * explicit source kind agrees with the dependency classification. */
export function validatePlanAgainstUnits(plan: SuccessorDeploymentPlanV1, catalog: DeploymentUnitCatalogV1): void {
  for (const [logicalId, source] of Object.entries(plan.contracts)) {
    const unit = catalog.units[source.unit];
    const definition = unit?.contracts[logicalId];
    if (!definition) throw new ConfigError('DEPLOYMENT_PLAN_UNKNOWN_CONTRACT', `Plan contract '${logicalId}' is not defined in unit '${source.unit}'`);
    const expectedKind = source.kind === 'external' ? 'external-contract' : source.kind === 'local-fixture' ? 'local-fixture' : 'artifact-build';
    if (definition.kind !== expectedKind) {
      throw new ConfigError('DEPLOYMENT_PLAN_SOURCE_MISMATCH', `Plan source '${source.kind}' for '${logicalId}' conflicts with unit classification '${definition.kind}'`);
    }
  }
  if (plan.selectedUnits.includes('sew-protocol')) throw new ConfigError('SUCCESSOR_SEW_EXCLUSION', 'Bounded successor plan must exclude Sew');
}

/** Ensure every contract in an architecture has exactly one deployment-unit owner. */
export function validateArchitectureUnitOwnership(logicalIds: string[], catalog: DeploymentUnitCatalogV1): void {
  const owners = new Map<string, string[]>();
  for (const [unitId, unit] of Object.entries(catalog.units)) {
    for (const logicalId of Object.keys(unit.contracts)) {
      const current = owners.get(logicalId) ?? [];
      current.push(unitId);
      owners.set(logicalId, current);
    }
  }
  for (const logicalId of logicalIds) {
    const matches = owners.get(logicalId) ?? [];
    if (matches.length === 0) throw new ConfigError('DEPLOYMENT_UNIT_UNASSIGNED', `Architecture contract '${logicalId}' has no deployment-unit owner`);
    if (matches.length > 1) throw new ConfigError('DEPLOYMENT_UNIT_MULTIPLE_OWNERS', `Architecture contract '${logicalId}' has multiple deployment-unit owners`, { details: { owners: matches } });
  }
}

/** This is deliberately the bounded successor plan, not a general workflow engine. */
export function validateSuccessorDeploymentPlan(plan: SuccessorDeploymentPlanV1): void {
  if (plan.planId === 'prf/controlled-shortfall-successor-fork.v1' && !plan.localOnly) {
    throw new ConfigError('SUCCESSOR_PLAN_LOCAL_ONLY', 'The current controlled-shortfall plan is a fork fixture and must remain localOnly');
  }
  const selected = new Set<string>(plan.selectedUnits);
  const excluded = new Set<string>(plan.excludedUnits);
  for (const unit of selected) {
    if (excluded.has(unit)) throw new ConfigError('DEPLOYMENT_PLAN_UNIT_CONFLICT', `Unit '${unit}' is both selected and excluded`);
  }
  for (const required of ['prf-assurance', 'protected-operations', 'pro-rata-successor-entitlements'] as const) {
    if (!selected.has(required)) throw new ConfigError('DEPLOYMENT_PLAN_UNIT_MISSING', `Successor plan omits required unit '${required}'`);
  }
  if (selected.has('sew-protocol') || !excluded.has('sew-protocol')) {
    throw new ConfigError('SUCCESSOR_SEW_EXCLUSION', 'Bounded successor plan must explicitly exclude the Sew protocol unit');
  }
  const contractIds = Object.keys(plan.contracts);
  if (contractIds.length === 0) throw new ConfigError('DEPLOYMENT_PLAN_EMPTY', 'Successor plan selects no contracts or external dependencies');
  assertAcyclicStageGraph(plan.stages);
  const seenStages = new Map<string, (typeof plan.stages)[number]>();
  const stageOutputs = new Map<string, Set<string>>();
  for (const stage of plan.stages) {
    if (seenStages.has(stage.id)) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_DUPLICATE', `Duplicate stage '${stage.id}'`);
    for (const dep of stage.dependsOn) {
      if (!seenStages.has(dep)) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_ORDER', `Stage '${stage.id}' depends on missing or later stage '${dep}'`);
    }
    const dependencySet = new Set(stage.dependsOn);
    for (const [input, reference] of Object.entries(stage.consumes)) {
      if (!dependencySet.has(reference.stage)) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_DEPENDENCY', `Stage '${stage.id}' input '${input}' references an undeclared stage dependency`);
      if (!stageOutputs.get(reference.stage)?.has(reference.output)) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_OUTPUT', `Stage '${stage.id}' input '${input}' references an undeclared output`);
    }
    if (new Set(stage.produces).size !== stage.produces.length || stage.produces.some((value) => value.length === 0)) {
      throw new ConfigError('DEPLOYMENT_PLAN_STAGE_OUTPUT', `Stage '${stage.id}' has empty or duplicate outputs`);
    }
    if (stage.contractOutputs) {
      if (stage.kind !== 'deploy' || Object.keys(stage.contractOutputs).some((output) => !stage.produces.includes(output))) {
        throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_OUTPUT', `Stage '${stage.id}' contractOutputs must map declared outputs of a deploy stage`);
      }
      const logicalIds = Object.values(stage.contractOutputs);
      if (new Set(logicalIds).size !== logicalIds.length) {
        throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_OUTPUT', `Stage '${stage.id}' contractOutputs must uniquely name contracts deployed by that stage`);
      }
    }
    seenStages.set(stage.id, stage);
    stageOutputs.set(stage.id, new Set(stage.produces));
  }
  for (const [logicalId, source] of Object.entries(plan.contracts)) {
    if (!selected.has(source.unit)) throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_UNIT', `'${logicalId}' belongs to unselected unit '${source.unit}'`);
    if (source.kind === 'deploy' || source.kind === 'external' || source.kind === 'local-fixture') {
      const stage = seenStages.get(source.stage);
      if (!stage) throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_STAGE', `'${logicalId}' refers to unknown stage '${source.stage}'`);
      const expectedKind = source.kind === 'external' ? 'external-preflight' : 'deploy';
      if (stage.kind !== expectedKind && !(source.kind === 'local-fixture' && stage.kind === 'deploy')) {
        throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_STAGE', `'${logicalId}' source '${source.kind}' is incompatible with stage '${source.stage}'`);
      }
    }
    if (source.kind === 'stage-output') {
      if (source.producer) {
        if (source.producer.planId === plan.planId && source.producer.planHash === deploymentPlanHash(plan)) {
          throw new ConfigError('DEPLOYMENT_PLAN_STAGE_OUTPUT_CYCLE', `Stage output '${logicalId}' cannot depend on itself`);
        }
      } else {
        const stage = seenStages.get(source.stage);
        if (!stage?.dependsOn.length) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_DEPENDENCY', `'${logicalId}' stage output must come from an explicitly declared earlier stage`);
        if (!stage?.produces.includes(source.output)) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_OUTPUT', `'${logicalId}' references an unavailable stage output`);
      }
    }
  }
  validateGenesisRootStageOrdering(plan);
  for (const stage of plan.stages) {
    for (const [output, logicalId] of Object.entries(stage.contractOutputs ?? {})) {
      const source = plan.contracts[logicalId];
      if (!source) continue; // A consumer plan may retain the producer's output map for provenance.
      if (source.kind === 'stage-output') {
        if (source.stage !== stage.id || source.output !== output) throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_OUTPUT', `Stage output '${stage.id}.${output}' conflicts with the selected cross-plan source for '${logicalId}'`);
      } else if (source.kind === 'admitted-release' || source.kind === 'external') {
        continue;
      } else if ((source.kind !== 'deploy' && source.kind !== 'local-fixture') || source.stage !== stage.id) {
        throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_OUTPUT', `Stage output '${stage.id}.${output}' does not identify a contract deployed by that stage`);
      }
    }
  }
  const stageIndex = new Map(plan.stages.map((stage, index) => [stage.id, index]));
  for (const action of plan.authorizedConfigurationActions) {
    if (!plan.contracts[action.target]) throw new ConfigError('DEPLOYMENT_PLAN_AUTH_TARGET', `Authorized action '${action.id}' targets unselected contract '${action.target}'`);
    if (!plan.stages.some((stage) => stage.kind === 'authorize-configuration' && stage.id === action.stage)) {
      throw new ConfigError('DEPLOYMENT_PLAN_AUTH_STAGE', `Authorized action '${action.id}' has no explicit authorization stage '${action.stage}'`);
    }
    const stage = plan.stages.find((candidate) => candidate.id === action.stage)!;
    if (!stage.dependsOn.length) throw new ConfigError('DEPLOYMENT_PLAN_AUTH_STAGE', `Authorized action '${action.id}' has no explicit prerequisite stage`);
    const targetSource = plan.contracts[action.target]!;
    if ((targetSource.kind === 'deploy' || targetSource.kind === 'external' || targetSource.kind === 'local-fixture') &&
        (stageIndex.get(targetSource.stage) ?? Number.MAX_SAFE_INTEGER) >= (stageIndex.get(action.stage) ?? -1)) {
      throw new ConfigError('DEPLOYMENT_PLAN_AUTH_TARGET_ORDER', `Authorized action '${action.id}' targets '${action.target}' before its source stage has completed`);
    }
  }
}

/**
 * Enforce the successor genesis cutpoint: protocol/authority roots and the
 * initial configuration (which commits the empty verifier registry) are
 * predeployment inputs. Address and runtime observations are introduced only
 * by the postdeployment chain-instance and successor-configuration stages.
 */
function validateGenesisRootStageOrdering(plan: SuccessorDeploymentPlanV1): void {
  const stages = new Map(plan.stages.map((stage, index) => [stage.id, { stage, index }]));
  const required = (id: string): { stage: SuccessorDeploymentPlanV1['stages'][number]; index: number } => {
    const found = stages.get(id);
    if (!found) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_ORDER', `Successor plan omits required genesis stage '${id}'`);
    return found;
  };
  const requireOutput = (consumer: SuccessorDeploymentPlanV1['stages'][number], input: string, producerId: string, output: string): void => {
    const ref = consumer.consumes[input];
    if (!ref || ref.stage !== producerId || ref.output !== output) {
      throw new ConfigError('DEPLOYMENT_PLAN_STAGE_OUTPUT', `Stage '${consumer.id}' must bind '${input}' to '${producerId}.${output}'`);
    }
  };

  const genesis = required('derive-genesis-roots');
  const initial = required('derive-initial-configuration');
  const localToken = required('deploy-local-token');
  const authorityAndVerifier = required('deploy-authority-and-verifier');
  const genesisDeploy = required('deploy-genesis');
  const chainInstance = required('derive-chain-instance-root');
  const chainSeal = required('seal-chain-instance-genesis');
  const registry = required('derive-registry-roots');
  const successorConfiguration = required('derive-successor-configuration');

  for (const output of ['protocolGenesisRoot', 'authorityStateRoot', 'emptyRegistryRoot']) {
    if (genesis.stage.kind !== 'derive-canonical-roots' || !genesis.stage.produces.includes(output)) {
      throw new ConfigError('DEPLOYMENT_PLAN_STAGE_OUTPUT', `Stage 'derive-genesis-roots' must produce '${output}' as a canonical derivation`);
    }
  }
  if (initial.stage.kind !== 'derive-canonical-roots') {
    throw new ConfigError('DEPLOYMENT_PLAN_STAGE_ORDER', "Stage 'derive-initial-configuration' must be a canonical derivation");
  }
  requireOutput(initial.stage, 'protocolGenesisRoot', 'derive-genesis-roots', 'protocolGenesisRoot');
  requireOutput(initial.stage, 'emptyRegistryRoot', 'derive-genesis-roots', 'emptyRegistryRoot');
  if (initial.stage.dependsOn.length !== 1 || initial.stage.dependsOn[0] !== 'derive-genesis-roots' ||
      Object.values(initial.stage.consumes).some((ref) => ['deploy-local-token', 'deploy-authority-and-verifier'].includes(ref.stage)) ||
      initial.stage.consumes.successorRegistryRoot) {
    throw new ConfigError('DEPLOYMENT_PLAN_INITIAL_CONFIGURATION_ORDER', 'Initial configuration must depend only on predeployment genesis inputs and the canonical empty verifier-registry root');
  }
  for (const deploy of [localToken, authorityAndVerifier, genesisDeploy]) {
    if (deploy.index <= initial.index) {
      throw new ConfigError('DEPLOYMENT_PLAN_INITIAL_CONFIGURATION_ORDER', `Initial configuration must be derived before deployment stage '${deploy.stage.id}'`);
    }
  }
  requireOutput(genesisDeploy.stage, 'protocolGenesisRoot', 'derive-genesis-roots', 'protocolGenesisRoot');
  requireOutput(genesisDeploy.stage, 'authorityStateRoot', 'derive-genesis-roots', 'authorityStateRoot');
  requireOutput(genesisDeploy.stage, 'initialConfigurationRoot', 'derive-initial-configuration', 'initialConfigurationRoot');
  if (!initial.stage.produces.includes('initialConfigurationRoot')) {
    throw new ConfigError('DEPLOYMENT_PLAN_STAGE_OUTPUT', "Stage 'derive-initial-configuration' must produce 'initialConfigurationRoot'");
  }
  for (const output of ['genesisAddress', 'genesisRuntimeCodeHash']) {
    requireOutput(chainInstance.stage, output, 'deploy-genesis', output);
  }
  requireOutput(chainInstance.stage, 'initialConfigurationRoot', 'derive-initial-configuration', 'initialConfigurationRoot');
  if (chainInstance.index <= genesisDeploy.index) {
    throw new ConfigError('DEPLOYMENT_PLAN_STAGE_ORDER', 'Chain-instance genesis must be derived after genesis deployment observations');
  }
  requireOutput(registry.stage, 'adapter', 'deploy-authority-and-verifier', 'successorAdapter');
  if (registry.index <= authorityAndVerifier.index) {
    throw new ConfigError('DEPLOYMENT_PLAN_STAGE_ORDER', 'Successor registry root must be derived after verifier adapter deployment');
  }
  requireOutput(successorConfiguration.stage, 'initialConfigurationRoot', 'derive-initial-configuration', 'initialConfigurationRoot');
  requireOutput(successorConfiguration.stage, 'successorRegistryRoot', 'derive-registry-roots', 'successorRegistryRoot');
  if (successorConfiguration.index <= registry.index || successorConfiguration.index <= chainSeal.index) {
    throw new ConfigError('DEPLOYMENT_PLAN_STAGE_ORDER', 'Successor configuration must follow chain-instance sealing and successor registry derivation');
  }
}

/** Reject stage cycles explicitly before enforcing the plan's topological order. */
function assertAcyclicStageGraph(stages: SuccessorDeploymentPlanV1['stages']): void {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const complete = new Set<string>();
  const active: string[] = [];
  const visit = (stageId: string): void => {
    const cycleStart = active.indexOf(stageId);
    if (cycleStart >= 0) {
      const cycle = [...active.slice(cycleStart), stageId];
      throw new ConfigError('DEPLOYMENT_PLAN_STAGE_CYCLE', `Deployment plan stage dependency cycle: ${cycle.join(' -> ')}`);
    }
    if (complete.has(stageId)) return;
    const stage = byId.get(stageId);
    if (!stage) throw new ConfigError('DEPLOYMENT_PLAN_STAGE_ORDER', `Stage dependency '${stageId}' does not exist`);
    active.push(stageId);
    for (const dependency of stage.dependsOn) visit(dependency);
    active.pop();
    complete.add(stageId);
  };
  for (const stage of stages) visit(stage.id);
}

/** Deployment CLI v1 can execute deployment/external-observation prerequisites only. */
export function unsupportedDeploymentPrerequisite(plan: SuccessorDeploymentPlanV1): { contract: string; stage: string } | undefined {
  const stages = new Map(plan.stages.map((stage) => [stage.id, stage]));
  const visit = (id: string, seen: Set<string>): string | undefined => {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const stage = stages.get(id);
    if (!stage) return id;
    if (stage.kind !== 'deploy' && stage.kind !== 'external-preflight') return id;
    for (const parent of stage.dependsOn) {
      const unresolved = visit(parent, seen);
      if (unresolved) return unresolved;
    }
    return undefined;
  };
  for (const [logicalId, source] of Object.entries(plan.contracts)) {
    if ((source.kind !== 'deploy' && source.kind !== 'local-fixture') || !('stage' in source)) continue;
    for (const prerequisite of stages.get(source.stage)?.dependsOn ?? []) {
      const unresolved = visit(prerequisite, new Set([source.stage]));
      if (unresolved) return { contract: logicalId, stage: unresolved };
    }
  }
  return undefined;
}

export function assertPlanDeployable(plan: SuccessorDeploymentPlanV1): void {
  const unavailable = unsupportedDeploymentPrerequisite(plan);
  if (unavailable) {
    throw new ConfigError('PLAN_STAGE_EXECUTOR_UNAVAILABLE', `Cannot start plan deployment: '${unavailable.contract}' depends on unimplemented stage '${unavailable.stage}'`);
  }
}

/**
 * Project the existing canonical configuration through an explicitly selected
 * deployment plan. The plan is authoritative for deployment selection and
 * stage ordering; architecture remains authoritative for artifacts and
 * constructor bindings. Unsupported provenance sources fail closed instead
 * of being interpreted as deployment instructions.
 */
export function projectConfigurationForPlan(
  config: LoadedConfig,
  environment: RawEnvironment,
  plan: SuccessorDeploymentPlanV1,
  options: { allowLocalFork?: boolean; stageOutputValues?: Readonly<Record<string, unknown>> } = {},
): { config: LoadedConfig; environment: RawEnvironment; deployedLogicalIds: string[]; consumedExternalIds: string[]; consumedStageOutputIds: string[] } {
  const architectureIds = new Set(Object.keys(config.architecture.contracts));
  const planIds = Object.keys(plan.contracts);
  for (const id of planIds) {
    if (!architectureIds.has(id)) {
      throw new ConfigError('DEPLOYMENT_PLAN_UNKNOWN_CONTRACT', `Plan selects '${id}', which is not present in the selected architecture profile`);
    }
  }
  const localExecution = environment.chain.kind === 'local' || options.allowLocalFork === true;
  if (plan.localOnly && !localExecution) {
    throw new ConfigError('LOCAL_FIXTURE_PUBLIC_ENVIRONMENT', 'A local-only deployment plan cannot execute on a public environment');
  }

  const stageOrder = new Map(plan.stages.map((stage, index) => [stage.id, index]));
  const deployable: string[] = [];
  const external: string[] = [];
  const stageOutputs: string[] = [];
  for (const [id, source] of Object.entries(plan.contracts)) {
    switch (source.kind) {
      case 'deploy':
        deployable.push(id);
        if (environment.externalContracts?.[id]) throw new ConfigError('PLAN_DEPLOY_EXTERNAL_CONFLICT', `Plan marks '${id}' for deployment but the environment binds it as external`);
        break;
      case 'local-fixture':
        if (!plan.localOnly || !localExecution) {
          throw new ConfigError('LOCAL_FIXTURE_PUBLIC_ENVIRONMENT', `Local fixture '${id}' cannot be selected outside local/fork environments`);
        }
        deployable.push(id);
        if (environment.externalContracts?.[id]) throw new ConfigError('PLAN_FIXTURE_EXTERNAL_CONFLICT', `Plan marks '${id}' as a local fixture but the environment binds it as external`);
        break;
      case 'external':
        external.push(id);
        if (!environment.externalContracts?.[id]) throw new ConfigError('PLAN_EXTERNAL_UNRESOLVED', `Plan external dependency '${id}' has no address binding in the selected environment`);
        if (environment.deploymentOrder.includes(id)) throw new ConfigError('PLAN_EXTERNAL_IN_DEPLOY_ORDER', `External dependency '${id}' appears in deploymentOrder`);
        break;
      case 'stage-output':
        {
          const value = options.stageOutputValues?.[id];
          if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).address !== 'string') {
            throw new ConfigError('PLAN_STAGE_OUTPUT_UNRESOLVED', `Stage output '${id}' has no receipt-bound address value`);
          }
          stageOutputs.push(id);
          break;
        }
      case 'admitted-release':
        throw new ConfigError('PLAN_ADMITTED_RELEASE_UNSUPPORTED', `Admitted release '${source.releaseId}' is declared but no admitted-release resolver is configured`);
    }
    if ('stage' in source && !(source.kind === 'stage-output' && source.producer)) {
      const stage = stageOrder.get(source.stage);
      if (stage === undefined) throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_STAGE', `No execution stage is declared for '${id}'`);
    }
  }

  const selected = new Set(planIds);
  const stageDependsOn = (consumerStage: string, producerStage: string): boolean => {
    const byId = new Map(plan.stages.map((stage) => [stage.id, stage]));
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === producerStage) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (byId.get(id)?.dependsOn ?? []).some(visit);
    };
    return visit(consumerStage);
  };
  for (const [id, contract] of Object.entries(config.architecture.contracts)) {
    if (!selected.has(id)) continue;
    const consumerSource = plan.contracts[id]!;
    const consumerStage = 'stage' in consumerSource ? consumerSource.stage : undefined;
    const dependencies = new Set([
      ...(contract.relationships?.dependsOn ?? []),
      ...Object.values(contract.constructorBindings ?? {}).flatMap(contractBindingReferences),
    ]);
    for (const dependencyId of dependencies) {
      const dependencySource = plan.contracts[dependencyId];
      if (dependencySource?.kind !== 'stage-output' || dependencySource.producer) continue;
      if (!consumerStage || stageOrder.get(dependencySource.stage)! >= stageOrder.get(consumerStage)! ||
          !stageDependsOn(consumerStage, dependencySource.stage)) {
        throw new ConfigError('PLAN_STAGE_OUTPUT_ORDER', `Selected contract '${id}' consumes stage output '${dependencyId}' without depending on its completed producer stage '${dependencySource.stage}'`);
      }
    }
    for (const dependency of contract.relationships?.dependsOn ?? []) {
      if (!selected.has(dependency)) throw new ConfigError('PLAN_UNRESOLVED_CONSTRUCTOR_DEPENDENCY', `Selected contract '${id}' depends on unselected '${dependency}'`);
    }
    for (const binding of Object.values(contract.constructorBindings ?? {})) {
      for (const reference of contractBindingReferences(binding)) {
        if (!selected.has(reference)) throw new ConfigError('PLAN_UNRESOLVED_CONSTRUCTOR_DEPENDENCY', `Selected contract '${id}' constructor references unselected '${reference}'`);
      }
    }
  }

  const originalIndex = new Map(environment.deploymentOrder.map((id, index) => [id, index]));
  const orderedDeployments = deployable.sort((a, b) => {
    const sourceA = plan.contracts[a]!;
    const sourceB = plan.contracts[b]!;
    if (!('stage' in sourceA) || !('stage' in sourceB)) throw new ConfigError('DEPLOYMENT_PLAN_CONTRACT_STAGE', 'Deployment source has no stage binding');
    const stageDiff = stageOrder.get(sourceA.stage)! - stageOrder.get(sourceB.stage)!;
    return stageDiff || (originalIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (originalIndex.get(b) ?? Number.MAX_SAFE_INTEGER);
  });
  const projectedConfig: LoadedConfig = {
    architecture: {
      ...config.architecture,
      contracts: Object.fromEntries(Object.entries(config.architecture.contracts).filter(([id]) => selected.has(id))),
    },
    governance: projectGovernance(config.governance, selected),
    verification: projectVerification(config.verification, selected),
  };
  const externalAddressNames = new Set<string>();
  for (const contract of Object.values(projectedConfig.architecture.contracts)) {
    for (const binding of Object.values(contract.constructorBindings ?? {})) collectExternalAddressReferences(binding, externalAddressNames);
  }
  for (const action of environment.bootstrapActions.filter((candidate) => selected.has(candidate.target))) {
    for (const binding of action.args) collectExternalAddressReferences(binding, externalAddressNames);
  }
  const projectedEnvironment: RawEnvironment = {
    ...environment,
    deploymentOrder: orderedDeployments,
    registryRoots: environment.registryRoots.filter((id) => selected.has(id)),
    overlays: environment.overlays
      ? Object.fromEntries(Object.entries(environment.overlays).filter(([id]) => selected.has(id)))
      : undefined,
    externalContracts: Object.fromEntries([
      ...Object.entries(environment.externalContracts ?? {}).filter(([id]) => external.includes(id)),
      ...stageOutputs.map((id) => [id, { address: (options.stageOutputValues![id] as { address: string }).address }] as const),
    ]),
    externalAddresses: environment.externalAddresses
      ? Object.fromEntries(Object.entries(environment.externalAddresses).filter(([name]) => externalAddressNames.has(name)))
      : undefined,
    bootstrapActions: environment.bootstrapActions.filter((action) => selected.has(action.target)),
    bootstrapAssertions: environment.bootstrapAssertions.filter((assertion) => selected.has(assertion.target)),
  };
  return { config: projectedConfig, environment: projectedEnvironment, deployedLogicalIds: orderedDeployments, consumedExternalIds: external, consumedStageOutputIds: stageOutputs };
}

/**
 * Reject known sentinel roots in the selected successor architecture before
 * resolving it into a deployable specification. A root literal that repeats
 * one byte across the full bytes32 word is a fixture marker, not an approved
 * canonical identity. This check deliberately does not attempt to decide
 * whether an otherwise well-formed root has semantic approval.
 */
export function assertNoPlaceholderRootBindings(config: LoadedConfig, logicalIds: string[]): void {
  const placeholder = /^0x([0-9a-fA-F]{2})\1{31}$/;
  const knownSentinelBytes = new Set(['00', '11', '22', '33', '44']);
  for (const logicalId of logicalIds) {
    const contract = config.architecture.contracts[logicalId];
    if (!contract) continue;
    for (const [bindingName, binding] of Object.entries(contract.constructorBindings ?? {})) {
      if (!/root/i.test(bindingName)) continue;
      const inspect = (value: import('../config/raw-types').RawBinding): void => {
        const match = 'literal' in value && typeof value.literal === 'string'
          ? placeholder.exec(value.literal)
          : null;
        if (match && knownSentinelBytes.has(match[1]!.toLowerCase())) {
          throw new ConfigError(
            'PLAN_PLACEHOLDER_ROOT_BINDING',
            `Selected contract '${logicalId}' has unqualified placeholder root binding '${bindingName}'`,
          );
        }
        if ('array' in value) value.array.forEach(inspect);
      };
      inspect(binding);
    }
  }
}

function contractBindingReferences(binding: import('../config/raw-types').RawBinding): string[] {
  if ('contractAddress' in binding) return [binding.contractAddress];
  if ('runtimeCodeHash' in binding) return [binding.runtimeCodeHash];
  if ('array' in binding) return binding.array.flatMap(contractBindingReferences);
  return [];
}

function collectExternalAddressReferences(binding: import('../config/raw-types').RawBinding, into: Set<string>): void {
  if ('externalAddress' in binding) into.add(binding.externalAddress);
  else if ('array' in binding) for (const nested of binding.array) collectExternalAddressReferences(nested, into);
}

function projectGovernance(governance: LoadedConfig['governance'], selected: Set<string>): LoadedConfig['governance'] {
  const tokens = Object.fromEntries(Object.entries(governance.tokens).filter(([, token]) => selected.has(token.contract)));
  const governors = Object.fromEntries(Object.entries(governance.governors).filter(([, governor]) => selected.has(governor.contract) && tokens[governor.token] !== undefined));
  const lanes = Object.fromEntries(Object.entries(governance.lanes).filter(([, lane]) => governors[lane.governor] !== undefined && selected.has(lane.timelock)));
  const groups = Object.fromEntries(Object.entries(governance.groups).flatMap(([id, group]) => {
    if (lanes[group.lane] === undefined) return [];
    const operations = Object.fromEntries(Object.entries(group.operations).filter(([, operation]) => selected.has(operation.target)));
    return Object.keys(operations).length ? [[id, { ...group, operations }]] : [];
  }));
  return { ...governance, tokens, governors, lanes, groups };
}

function projectVerification(verification: LoadedConfig['verification'], selected: Set<string>): LoadedConfig['verification'] {
  const verifierImplementations = Object.fromEntries(Object.entries(verification.verifierImplementations).filter(([, implementation]) => selected.has(implementation.contract)));
  const implementationIds = new Set(Object.keys(verifierImplementations));
  const verificationProfiles = Object.fromEntries(Object.entries(verification.verificationProfiles).filter(([, profile]) => implementationIds.has(profile.verifierImplementation)));
  const profileIds = new Set(Object.keys(verificationProfiles));
  const applications = Object.fromEntries(Object.entries(verification.applications).filter(([, application]) => profileIds.has(application.verificationProfile)));
  return { ...verification, verifierImplementations, verificationProfiles, applications };
}
