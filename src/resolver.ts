import { ConfigError } from './errors';
import type { BundleConsumer } from './artifacts/bundle';
import type { ResolvedArtifact } from './artifacts/types';
import type { LoadedConfig } from './config/load';
import type {
  RawLogicalContract,
  RawParameter,
  RawArtifactSource,
  RawEnvironment,
  RelationshipKey,
} from './config/raw-types';
import { RELATIONSHIP_KEYS as REL_KEYS } from './config/raw-types';
import type {
  ResolvedSpec,
  ResolvedContract,
  ResolvedParameter,
  ResolvedGovernanceGroup,
  ResolvedLane,
  ResolvedGovernor,
  ResolvedVerification,
  ResolvedVerificationProfile,
  ResolvedVerifierInstance,
  ResolvedChain,
  ResolvedDeploymentPlan,
  DeploymentPlanStep,
  ResolvedRelationship,
} from './canonical';

const REL: readonly RelationshipKey[] = REL_KEYS;

export interface ResolveInput {
  config: LoadedConfig;
  environment: RawEnvironment;
  bundle: BundleConsumer;
}

export interface ResolveOptions {
  /** provenance tag for the chain binding (e.g. environment name). */
  environmentSource?: string;
}

function requireKnown(
  id: string,
  known: ReadonlySet<string>,
  code: string,
  what: string,
): void {
  if (!known.has(id)) {
    throw new ConfigError(code, `Unknown ${what} '${id}'`, { details: { id } });
  }
}

function paramValueToJson(v: RawParameter['value']): string | number | boolean {
  if (typeof v === 'bigint') return v.toString();
  return v;
}

function bigintToJson(v: bigint): string {
  return v.toString();
}

export function resolve(input: ResolveInput, options: ResolveOptions = {}): ResolvedSpec {
  const { config, environment, bundle } = input;
  const { architecture, governance, verification } = config;

  const contractIds = new Set(Object.keys(architecture.contracts));
  const sourceIds = new Set(Object.keys(architecture.artifactSources));

  // ---------------------------------------------------------------------
  // 1. Validate artifact source references and bind artifacts.
  // ---------------------------------------------------------------------
  const artifacts: Record<string, ResolvedArtifact> = {};
  const rawContracts: Record<string, RawLogicalContract> = {};

  for (const [logicalId, rc] of Object.entries(architecture.contracts)) {
    requireKnown(rc.artifactSource, sourceIds, 'UNKNOWN_ARTIFACT_SOURCE', `artifact source '${rc.artifactSource}' for contract`);
    const srcDef: RawArtifactSource = architecture.artifactSources[rc.artifactSource]!;
    const key = `${rc.artifactSource}/${rc.artifact}`;
    if (!artifacts[key]) {
      const resolvedArtifact = bundle.bindArtifact(
        rc.artifactSource,
        srcDef.package,
        srcDef.version,
        rc.artifact,
      );
      artifacts[key] = resolvedArtifact;
    }
    rawContracts[logicalId] = rc;
  }

  // ---------------------------------------------------------------------
  // 2. Validate relationships (known targets + dependency cycles).
  // ---------------------------------------------------------------------
  for (const [logicalId, rc] of Object.entries(rawContracts)) {
    const rels = rc.relationships ?? {};
    for (const key of REL) {
      const targets = rels[key] ?? [];
      for (const t of targets) {
        requireKnown(t, contractIds, 'UNKNOWN_DEPENDENCY', `relationship '${key}' target`);
        if (t === logicalId) {
          throw new ConfigError('DEPENDENCY_CYCLE', `Contract '${logicalId}' references itself in relationship '${key}'`);
        }
      }
    }
  }
  detectDependencyCycles(rawContracts);

  // ---------------------------------------------------------------------
  // 3. Apply environment overlay to parameters.
  // ---------------------------------------------------------------------
  const appliedParams: Record<string, Record<string, RawParameter>> = {};
  for (const [logicalId, rc] of Object.entries(rawContracts)) {
    appliedParams[logicalId] = { ...(rc.parameters ?? {}) };
  }

  const overlays = environment.overlays ?? ({} as Record<string, { parameters: Record<string, RawParameter> }>);
  for (const [logicalId, overlay] of Object.entries(overlays)) {
    requireKnown(logicalId, contractIds, 'UNKNOWN_LOGICAL_CONTRACT', 'overlay target');
    const base = appliedParams[logicalId]!;
    for (const [pname, op] of Object.entries(overlay.parameters)) {
      if (base[pname] === undefined) {
        throw new ConfigError(
          'UNKNOWN_PARAMETER',
          `Environment overlay sets parameter '${pname}' on '${logicalId}' which is not declared`,
        );
      }
      const baseP = base[pname]!;
      base[pname] = { ...baseP, value: op.value };
    }
  }

  // ---------------------------------------------------------------------
  // 4. Validate parameter values against constraints.
  // ---------------------------------------------------------------------
  validateParameterConstraints(rawContracts, appliedParams);

  // ---------------------------------------------------------------------
  // 5. Resolve governance.
  // ---------------------------------------------------------------------
  const governanceResult = resolveGovernance(governance, contractIds, rawContracts);

  // ---------------------------------------------------------------------
  // 6. Resolve verification.
  // ---------------------------------------------------------------------
  const verificationResult = resolveVerification(verification, contractIds, rawContracts);

  // ---------------------------------------------------------------------
  // 7. Resolve chain binding.
  // ---------------------------------------------------------------------
  const chain: ResolvedChain = {
    logicalRole: environment.chain.logicalRole,
    chainId: environment.chain.chainId,
    kind: environment.chain.kind,
    source: options.environmentSource ?? environment.environment,
  };
  if (!Number.isInteger(chain.chainId) || chain.chainId <= 0) {
    throw new ConfigError('UNRESOLVED_CHAIN_BINDING', `Invalid chainId ${chain.chainId} for environment '${environment.environment}'`);
  }

  // ---------------------------------------------------------------------
  // 8. Resolve deployment order (explicit) + dependency satisfaction.
  // ---------------------------------------------------------------------
  const deployment = resolveDeploymentOrder(environment, contractIds, rawContracts);

  // ---------------------------------------------------------------------
  // 9. Assemble resolved contracts.
  // ---------------------------------------------------------------------
  const contracts: Record<string, ResolvedContract> = {};
  const orderOf: Record<string, number> = {};
  deployment.steps.forEach((s) => {
    orderOf[s.logicalId] = s.order;
  });

  for (const [logicalId, rc] of Object.entries(rawContracts)) {
    const srcDef = architecture.artifactSources[rc.artifactSource]!;
    const artifact = artifacts[`${rc.artifactSource}/${rc.artifact}`]!;
    const params = appliedParams[logicalId]!;

    const parameters: ResolvedParameter[] = Object.entries(params).map(([name, p]) => {
      const baseDeclared = (rc.parameters ?? {})[name] !== undefined;
      const overriddenByEnv = environment.overlays?.[logicalId]?.parameters[name] !== undefined;
      return {
        name,
        value: paramValueToJson(p.value),
        mutability: p.mutability,
        constraint: p.constraint
          ? 'range' in p.constraint
            ? { type: 'range', min: p.constraint.range[0].toString(), max: p.constraint.range[1].toString() }
            : { type: 'oneOf', values: p.constraint.oneOf.map((x) => x.toString()) }
          : undefined,
        overriddenByEnv,
        valueSource: overriddenByEnv ? 'environment' : baseDeclared ? 'architecture' : 'architecture',
      };
    });

    const relationships: ResolvedRelationship[] = [];
    for (const key of REL) {
      for (const target of rc.relationships?.[key] ?? []) {
        relationships.push({ key, target });
      }
    }

    contracts[logicalId] = {
      logicalId,
      scope: rc.scope,
      artifactSource: rc.artifactSource,
      artifactName: rc.artifact,
      artifact,
      parameters,
      relationships,
      deploymentOrder: orderOf[logicalId] ?? 0,
      governedByGroups: governanceResult.contractToGroups[logicalId] ?? [],
    };
  }

  // ---------------------------------------------------------------------
  // 10. Intended state snapshot (chain + params). Observed is separate.
  // ---------------------------------------------------------------------
  const intendedParams: Record<string, unknown> = {};
  for (const [logicalId, rc] of Object.entries(contracts)) {
    intendedParams[logicalId] = {
      logicalId: rc.logicalId,
      parameters: Object.fromEntries(rc.parameters.map((p) => [p.name, p.value])),
    };
  }

  const spec: ResolvedSpec = {
    specVersion: 1,
    environment: environment.environment,
    chain,
    artifacts,
    contracts,
    governance: governanceResult.governance,
    verification: verificationResult,
    deployment,
    intended: {
      chainId: chain.chainId,
      contracts: intendedParams as ResolvedSpec['intended']['contracts'],
    },
  };

  return spec;
}

// ---------------------------------------------------------------------------
// Dependency cycles
// ---------------------------------------------------------------------------

function detectDependencyCycles(
  contracts: Record<string, RawLogicalContract>,
): void {
  const GRAY = 1;
  const BLACK = 2;
  // Unvisited nodes have color undefined; GRAY = on the current DFS stack.
  const color: Record<string, number | undefined> = {};
  const dependents = (id: string): string[] => contracts[id]?.relationships?.dependsOn ?? [];

  const visit = (id: string, trail: string[]): void => {
    color[id] = GRAY;
    for (const dep of dependents(id)) {
      if (color[dep] === GRAY) {
        const cycle = [...trail, dep].join(' -> ');
        throw new ConfigError('DEPENDENCY_CYCLE', `Dependency cycle detected: ${cycle}`);
      }
      if (color[dep] === undefined) visit(dep, [...trail, dep]);
    }
    color[id] = BLACK;
  };

  for (const id of Object.keys(contracts)) {
    if (color[id] === undefined) visit(id, [id]);
  }
}

// ---------------------------------------------------------------------------
// Parameter constraints
// ---------------------------------------------------------------------------

function validateParameterConstraints(
  contracts: Record<string, RawLogicalContract>,
  applied: Record<string, Record<string, RawParameter>>,
): void {
  for (const [logicalId, params] of Object.entries(applied)) {
    void contracts;
    for (const [pname, p] of Object.entries(params)) {
      if (p.constraint === undefined) continue;
      const c = p.constraint;
      const v = p.value;
      if (typeof v !== 'bigint') {
        throw new ConfigError(
          'PARAM_OUT_OF_CONSTRAINT',
          `Parameter '${logicalId}.${pname}' has a constraint but its value is not an integer`,
        );
      }
      if ('range' in c) {
        const [lo, hi] = c.range;
        if (v < lo || v > hi) {
          throw new ConfigError(
            'PARAM_OUT_OF_CONSTRAINT',
            `Parameter '${logicalId}.${pname}' value ${v} outside range [${lo}, ${hi}]`,
          );
        }
      } else {
        if (!c.oneOf.includes(v)) {
          throw new ConfigError(
            'PARAM_OUT_OF_CONSTRAINT',
            `Parameter '${logicalId}.${pname}' value ${v} not in allowed set [${c.oneOf.join(', ')}]`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Governance resolution
// ---------------------------------------------------------------------------

interface GovernanceResult {
  governance: ResolvedSpec['governance'];
  contractToGroups: Record<string, string[]>;
}

function resolveGovernance(
  governance: LoadedConfig['governance'],
  contractIds: ReadonlySet<string>,
  contracts: Record<string, RawLogicalContract>,
): GovernanceResult {
  const governorIds = new Set(Object.keys(governance.governors));
  const laneIds = new Set(Object.keys(governance.lanes));
  const tokenIds = new Set(Object.keys(governance.tokens ?? {}));

  // token id -> logical contract id
  const tokenContracts: Record<string, string> = {};
  for (const [tid, t] of Object.entries(governance.tokens ?? {})) {
    requireKnown(t.contract, contractIds, 'UNKNOWN_LOGICAL_CONTRACT', `token '${tid}' contract`);
    tokenContracts[tid] = t.contract;
  }

  const governors: ResolvedGovernor[] = Object.entries(governance.governors).map(
    ([id, g]) => {
      requireKnown(g.contract, contractIds, 'UNKNOWN_LOGICAL_CONTRACT', `governor '${id}' contract`);
      requireKnown(g.token, tokenIds, 'UNKNOWN_TOKEN', `governor '${id}' token`);
      return {
        id,
        contract: g.contract,
        token: tokenContracts[g.token]!,
        tokenSource: g.token,
        quorum: g.quorum !== undefined ? bigintToJson(g.quorum) : undefined,
        proposalThreshold: g.proposalThreshold !== undefined ? bigintToJson(g.proposalThreshold) : undefined,
      };
    },
  );

  const lanes: ResolvedLane[] = Object.entries(governance.lanes).map(([id, l]) => {
    requireKnown(l.governor, governorIds, 'UNKNOWN_GOVERNOR', `lane '${id}' governor`);
    requireKnown(l.timelock, contractIds, 'UNKNOWN_LOGICAL_CONTRACT', `lane '${id}' timelock`);
    return { id, governor: l.governor, timelock: l.timelock };
  });

  const groups: ResolvedGovernanceGroup[] = [];
  const contractToGroups: Record<string, string[]> = {};
  // Track which (contract, parameter) are governed by some group.
  const governedParams = new Set<string>();

  for (const [gid, g] of Object.entries(governance.groups)) {
    requireKnown(g.lane, laneIds, 'UNKNOWN_GOVERNANCE_GROUP', `group '${gid}' lane`);
    const operations = Object.entries(g.operations).map(([oid, op]) => {
      requireKnown(op.target, contractIds, 'UNKNOWN_LOGICAL_CONTRACT', `group '${gid}' operation '${oid}' target`);
      const cparams = contracts[op.target]?.parameters ?? {};
      if (cparams[op.parameter] === undefined) {
        throw new ConfigError(
          'UNKNOWN_PARAMETER',
          `Group '${gid}' operation '${oid}' targets parameter '${op.parameter}' not declared on '${op.target}'`,
        );
      }
      contractToGroups[op.target] = [...(contractToGroups[op.target] ?? []), gid];
      governedParams.add(`${op.target}.${op.parameter}`);
      return { id: oid, target: op.target, parameter: op.parameter };
    });
    groups.push({ id: gid, lane: g.lane, operations });
  }

  // Validate governed parameters have authority; immutable not assigned governance.
  for (const [logicalId, rc] of Object.entries(contracts)) {
    for (const [pname, p] of Object.entries(rc.parameters ?? {})) {
      if (p.mutability === 'governed' && !governedParams.has(`${logicalId}.${pname}`)) {
        throw new ConfigError(
          'GOVERNED_PARAM_NO_AUTHORITY',
          `Parameter '${logicalId}.${pname}' is governed but no governance group assigns it authority`,
        );
      }
      if (p.mutability === 'immutable' && governedParams.has(`${logicalId}.${pname}`)) {
        throw new ConfigError(
          'IMMUTABLE_ASSIGNED_GOVERNANCE',
          `Parameter '${logicalId}.${pname}' is immutable but a governance group attempts to govern it`,
        );
      }
    }
  }

  return {
    governance: { governors, lanes, groups },
    contractToGroups,
  };
}

// ---------------------------------------------------------------------------
// Verification resolution
// ---------------------------------------------------------------------------

function resolveVerification(
  verification: LoadedConfig['verification'],
  contractIds: ReadonlySet<string>,
  contracts: Record<string, RawLogicalContract>,
): ResolvedVerification {
  const implIds = new Set(Object.keys(verification.verifierImplementations));
  const profileIds = new Set(Object.keys(verification.verificationProfiles));

  const profiles: ResolvedVerificationProfile[] = Object.entries(
    verification.verificationProfiles,
  ).map(([id, p]) => {
    requireKnown(p.verifierImplementation, implIds, 'UNKNOWN_VERIFIER_IMPLEMENTATION', `profile '${id}' implementation`);
    return {
      id,
      verifierImplementation: p.verifierImplementation,
      programId: p.programId,
      vkHash: p.vkHash,
      statement: p.statement,
    };
  });

  const verifierInstances: Record<string, ResolvedVerifierInstance> = {};
  for (const [id, v] of Object.entries(verification.verifierImplementations)) {
    requireKnown(v.contract, contractIds, 'UNKNOWN_LOGICAL_CONTRACT', `verifier implementation '${id}' contract`);
    const rc = contracts[v.contract]!;
    verifierInstances[id] = {
      contract: v.contract,
      artifactSource: rc.artifactSource,
      artifactName: rc.artifact,
    };
  }

  const applications = Object.entries(verification.applications).map(([id, app]) => {
    requireKnown(app.verificationProfile, profileIds, 'UNKNOWN_VERIFIER_PROFILE', `application '${id}' profile`);
    const profile = profiles.find((p) => p.id === app.verificationProfile)!;
    const impl = profile.verifierImplementation;
    return {
      id,
      verificationProfile: app.verificationProfile,
      profile,
      verifierInstance: verifierInstances[impl]!,
    };
  });

  return { applications, profiles, verifierInstances };
}

// ---------------------------------------------------------------------------
// Deployment order
// ---------------------------------------------------------------------------

function resolveDeploymentOrder(
  environment: RawEnvironment,
  contractIds: ReadonlySet<string>,
  contracts: Record<string, RawLogicalContract>,
): ResolvedDeploymentPlan {
  const order = environment.deploymentOrder;
  const seen = new Set<string>();
  const steps: DeploymentPlanStep[] = [];

  if (order.length === 0) {
    throw new ConfigError(
      'UNRESOLVED_DEPLOYMENT_ORDER',
      `Environment '${environment.environment}' declares an empty deployment order`,
    );
  }

  order.forEach((id, idx) => {
    requireKnown(id, contractIds, 'UNKNOWN_LOGICAL_CONTRACT', 'deployment order entry');
    if (seen.has(id)) {
      throw new ConfigError('DUPLICATE_LOGICAL_ID', `Deployment order lists '${id}' more than once`);
    }
    seen.add(id);

    const dependsOn = contracts[id]?.relationships?.dependsOn ?? [];
    const prior = order.slice(0, idx);
    const priorSet = new Set(prior);
    for (const d of dependsOn) {
      if (!priorSet.has(d)) {
        throw new ConfigError(
          'DEPENDENCY_ORDER_VIOLATION',
          `Contract '${id}' (step ${idx}) depends on '${d}' which is not deployed earlier in the explicit order`,
        );
      }
    }
    steps.push({ logicalId: id, order: idx, dependsOn });
  });

  // Every logical contract must appear in the explicit order.
  for (const id of contractIds) {
    if (!seen.has(id)) {
      throw new ConfigError(
        'UNRESOLVED_DEPLOYMENT_ORDER',
        `Contract '${id}' is declared in architecture but missing from the explicit deployment order`,
      );
    }
  }

  return { steps, chainId: environment.chain.chainId };
}
