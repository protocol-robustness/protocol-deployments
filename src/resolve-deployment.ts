import * as path from 'path';
import { loadConfig, loadEnvironment, loadRuntime } from './config/load';
import { createBundleConsumer } from './artifacts/bundle';
import { resolve } from './resolver';
import { computeSpecHash } from './spec-hash';
import { canonicalJson } from './canonical-json';
import { ConfigError } from './errors';
import type { ResolvedSpec } from './canonical';
import { assertNoPlaceholderRootBindings, readDeploymentUnitCatalog, readSuccessorDeploymentPlan, validatePlanAgainstUnits, projectConfigurationForPlan } from './deployment/successor-plan';
import { readStageOutputReceiptDirectory, stageOutputValuesForPlan, type StageOutputReceiptV1 } from './deployment/stage-output';
import { readCrossPlanStageOutputEvidenceDirectory, verifyCrossPlanStageOutput, type CrossPlanStageOutputEvidenceV1 } from './deployment/cross-plan-stage-output';

export interface ResolvedDeploymentOutput {
  spec: ResolvedSpec;
  specHash: string;
  canonicalJson: string;
  deploymentPlan?: import('./deployment/successor-plan').SuccessorDeploymentPlanV1;
  stageOutputReceipts?: Record<string, import('./deployment/stage-output').StageOutputReceiptV1>;
  crossPlanStageOutputEvidence?: Record<string, CrossPlanStageOutputEvidenceV1>;
}

export interface ApprovedCanonicalRootBindings {
  protocolGenesisRoot: string;
  authorityStateRoot: string;
  localAuthorityPolicyRoot: string;
  initialConfigurationRoot: string;
  initialVerifierRegistryRoot: string;
  authorityTransitionValidatorAddress: string;
}

export function bindApprovedCanonicalRoots(
  config: ReturnType<typeof loadConfig>,
  roots: ApprovedCanonicalRootBindings,
): ReturnType<typeof loadConfig> {
  const values: Record<string, Record<string, string>> = {
    'prf/governance-authority': {
      protocolGenesisRoot_: roots.protocolGenesisRoot,
      initialAuthorityStateRoot_: roots.authorityStateRoot,
    },
    'prf/genesis': {
      protocolGenesisRoot_: roots.protocolGenesisRoot,
      initialAuthorityStateRoot_: roots.authorityStateRoot,
      initialConfigurationRoot_: roots.initialConfigurationRoot,
    },
    'prf/configuration-executor': {
      initialVerifierRegistryRoot_: roots.initialVerifierRegistryRoot,
    },
    'prf/authority-transition-validator': {
      localAuthorityPolicyRoot_: roots.localAuthorityPolicyRoot,
    },
    'prf/statement-admission': {
      expectedConfigurationRoot_: roots.initialConfigurationRoot,
    },
  };
  const addressValues: Record<string, Record<string, string>> = {
    'prf/authority-transition-validator': {
      transitionValidatorAddress_: roots.authorityTransitionValidatorAddress,
    },
  };
  const bytes32 = /^0x[0-9a-fA-F]{64}$/;
  for (const fields of Object.values(values)) {
    for (const value of Object.values(fields)) {
      if (!bytes32.test(value)) throw new ConfigError('APPROVED_ROOT_BINDING_INVALID', 'Authenticated canonical roots must be 32-byte EVM values');
    }
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(roots.authorityTransitionValidatorAddress) || /^0x0{40}$/i.test(roots.authorityTransitionValidatorAddress)) {
    throw new ConfigError('APPROVED_ROOT_BINDING_INVALID', 'Authenticated transition-validator address must be a nonzero 20-byte EVM address');
  }
  const contracts = { ...config.architecture.contracts };
  for (const [logicalId, fields] of Object.entries(values)) {
    const contract = contracts[logicalId];
    if (!contract) continue;
    const constructorBindings = { ...(contract.constructorBindings ?? {}) };
    for (const [name, approvedValue] of Object.entries(fields)) {
      const existing = constructorBindings[name];
      if (!existing || !('literal' in existing) || typeof existing.literal !== 'string') {
        throw new ConfigError('APPROVED_ROOT_BINDING_TARGET_INVALID', `Approved root '${logicalId}.${name}' is not a literal constructor binding`);
      }
      const placeholder = /^0x([0-9a-fA-F]{2})\1{31}$/.test(existing.literal);
      if (!placeholder && existing.literal.toLowerCase() !== approvedValue.toLowerCase()) {
        throw new ConfigError('APPROVED_ROOT_BINDING_MISMATCH', `Configured root '${logicalId}.${name}' differs from its authenticated canonical input`);
      }
      constructorBindings[name] = { literal: approvedValue };
    }
    contracts[logicalId] = { ...contract, constructorBindings };
  }
  for (const [logicalId, fields] of Object.entries(addressValues)) {
    const contract = contracts[logicalId];
    if (!contract) continue;
    const constructorBindings = { ...(contract.constructorBindings ?? {}) };
    for (const [name, approvedValue] of Object.entries(fields)) {
      const existing = constructorBindings[name];
      if (!existing || !('literal' in existing) || typeof existing.literal !== 'string') {
        throw new ConfigError('APPROVED_ROOT_BINDING_TARGET_INVALID', `Approved address '${logicalId}.${name}' is not a literal constructor binding`);
      }
      const placeholder = /^0x([0-9a-fA-F]{2})\1{19}$/.test(existing.literal);
      if (!placeholder && existing.literal.toLowerCase() !== approvedValue.toLowerCase()) {
        throw new ConfigError('APPROVED_ROOT_BINDING_MISMATCH', `Configured address '${logicalId}.${name}' differs from its authenticated canonical input`);
      }
      constructorBindings[name] = { literal: approvedValue };
    }
    contracts[logicalId] = { ...contract, constructorBindings };
  }
  return { ...config, architecture: { ...config.architecture, contracts } };
}

/**
 * Full Phase 1 resolution pipeline:
 *   EDN config -> parse -> validate -> resolve -> canonical JSON + spec hash.
 * No transactions are performed.
 */
export function resolveDeployment(opts: {
  configDir: string;
  environment: string;
  fixtureRoot: string;
  profileDir?: string;
  nodeModulesDir?: string;
  /** Local development reads every source from fixtures (default true). */
  preferFixtures?: boolean;
  /** Require clean-git provenance for every loaded bundle. */
  requirePinnedProvenance?: boolean;
  /** Explicit executable deployment plan. Omitting it keeps legacy flat resolution. */
  deploymentPlanFile?: string;
  /** Immutable receipts produced by earlier stages of the same selected plan. */
  stageOutputReceiptsDir?: string;
  /** Retained producer plan, execution, manifest and live-observation evidence for cross-plan outputs. */
  crossPlanStageOutputEvidenceDir?: string;
  /** Roots extracted only from a successfully authenticated PRF review manifest. */
  approvedRootBindings?: ApprovedCanonicalRootBindings;
}): ResolvedDeploymentOutput {
  let config = loadConfig({ configDir: opts.configDir, profileDir: opts.profileDir });
  let environment = loadEnvironment(opts.configDir, opts.environment, opts.profileDir);
  let deploymentPlan: import('./deployment/successor-plan').SuccessorDeploymentPlanV1 | undefined;
  let stageOutputReceipts: Record<string, StageOutputReceiptV1> | undefined;
  let crossPlanStageOutputEvidence: Record<string, CrossPlanStageOutputEvidenceV1> | undefined;
  if (opts.deploymentPlanFile) {
    const plan = readSuccessorDeploymentPlan(opts.deploymentPlanFile);
    deploymentPlan = plan;
    const catalog = readDeploymentUnitCatalog(path.join(opts.configDir, 'deployment-units.v1.json'));
    validatePlanAgainstUnits(plan, catalog);
    if (opts.approvedRootBindings) {
      config = bindApprovedCanonicalRoots(config, opts.approvedRootBindings);
      if (config.architecture.contracts['prf/authority-transition-validator']) {
        const action = environment.bootstrapActions.find((candidate) => candidate.id === 'prf/enable-authority-transitions');
        const policyRoot = action?.args[1];
        if (!action || action.target !== 'prf/governance-authority' || action.function !== 'enableAuthorityTransitions' ||
            !policyRoot || !('literal' in policyRoot) || typeof policyRoot.literal !== 'string') {
          throw new ConfigError('APPROVED_ROOT_BINDING_TARGET_INVALID', 'Policy-v3 deployment must bind the approved root into the authority-transition enablement action');
        }
        const placeholder = /^0x([0-9a-fA-F]{2})\1{31}$/.test(policyRoot.literal);
        if (!placeholder && policyRoot.literal.toLowerCase() !== opts.approvedRootBindings.localAuthorityPolicyRoot.toLowerCase()) {
          throw new ConfigError('APPROVED_ROOT_BINDING_MISMATCH', 'Configured transition policy root differs from its authenticated canonical input');
        }
        action.args[1] = { literal: opts.approvedRootBindings.localAuthorityPolicyRoot };
        const policyAssertion = environment.bootstrapAssertions.find((assertion) => assertion.id === 'prf/authority-transition-policy-root');
        if (!policyAssertion || policyAssertion.expected === undefined || typeof policyAssertion.expected !== 'string') {
          throw new ConfigError('APPROVED_ROOT_BINDING_TARGET_INVALID', 'Policy-v3 deployment must assert the approved authority policy root after enablement');
        }
        const assertionPlaceholder = /^0x([0-9a-fA-F]{2})\1{31}$/.test(policyAssertion.expected);
        if (!assertionPlaceholder && policyAssertion.expected.toLowerCase() !== opts.approvedRootBindings.localAuthorityPolicyRoot.toLowerCase()) {
          throw new ConfigError('APPROVED_ROOT_BINDING_MISMATCH', 'Configured authority policy assertion differs from its authenticated canonical input');
        }
        policyAssertion.expected = opts.approvedRootBindings.localAuthorityPolicyRoot;
      }
    }
    assertNoPlaceholderRootBindings(config, Object.keys(plan.contracts));
    const allowLocalFork = plan.localOnly && environment.chain.kind !== 'local'
      ? loadRuntime(opts.configDir, opts.environment).provider === 'anvil-fork'
      : false;
    if (opts.stageOutputReceiptsDir) stageOutputReceipts = readStageOutputReceiptDirectory(opts.stageOutputReceiptsDir);
    const hasCrossPlan = Object.values(plan.contracts).some((source) => source.kind === 'stage-output' && source.producer);
    if (opts.crossPlanStageOutputEvidenceDir) crossPlanStageOutputEvidence = readCrossPlanStageOutputEvidenceDirectory(opts.crossPlanStageOutputEvidenceDir);
    if (hasCrossPlan && !crossPlanStageOutputEvidence) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_REQUIRED', 'Cross-plan stage-output dependencies require --cross-plan-stage-output-evidence');
    const expectedEvidenceIds = Object.entries(plan.contracts).filter(([, source]) => source.kind === 'stage-output' && source.producer).map(([id]) => id).sort();
    if (crossPlanStageOutputEvidence && canonicalJson(Object.keys(crossPlanStageOutputEvidence).sort()) !== canonicalJson(expectedEvidenceIds)) {
      throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_SET', 'Cross-plan evidence set does not exactly match the selected plan dependencies');
    }
    const crossPlanValues: Record<string, unknown> = {};
    for (const [logicalId, source] of Object.entries(plan.contracts)) {
      if (source.kind !== 'stage-output' || !source.producer) continue;
      const evidence = crossPlanStageOutputEvidence?.[logicalId];
      if (!evidence) throw new ConfigError('CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_REQUIRED', `Pinned cross-plan producer evidence is missing for '${logicalId}'`);
      const verified = verifyCrossPlanStageOutput({ consumerPlan: plan, logicalId, evidence, expectedChainId: environment.chain.chainId });
      crossPlanValues[logicalId] = verified.value;
    }
    const stageOutputValues = stageOutputValuesForPlan(plan, stageOutputReceipts ?? {}, crossPlanValues);
    ({ config, environment } = projectConfigurationForPlan(config, environment, plan, { allowLocalFork, stageOutputValues }));
  }
  const bundle = createBundleConsumer({
    sources: config.architecture.artifactSources,
    fixtureRoot: opts.fixtureRoot,
    nodeModulesDir: opts.nodeModulesDir,
    preferFixtures: opts.preferFixtures,
    requirePinnedProvenance: opts.requirePinnedProvenance,
  });

  const spec = resolve(
    { config, environment, bundle },
    { environmentSource: environment.environment },
  );

  const canonical = canonicalJson(spec);
  const specHash = computeSpecHash(spec);

  return { spec, specHash, canonicalJson: canonical, deploymentPlan, stageOutputReceipts, crossPlanStageOutputEvidence };
}
