import { canonicalJson } from '../canonical-json';
import { keccak256Hex } from '../artifacts/hash';
import { ConfigError } from '../errors';
import type { DeploymentManifest } from './manifest';
import type { SuccessorDeploymentPlanV1 } from './successor-plan';

export const DEPLOYMENT_PLAN_DOMAIN = 'prf-deployment-plan:v1:';
export const PLAN_EXECUTION_DOMAIN = 'prf-deployment-plan-execution:v1:';

export function deploymentPlanHash(plan: SuccessorDeploymentPlanV1): string {
  return `0x${keccak256Hex(`${DEPLOYMENT_PLAN_DOMAIN}${canonicalJson(plan)}`)}`;
}

export function planExecutionRoot(body: Record<string, unknown>): string {
  return `0x${keccak256Hex(`${PLAN_EXECUTION_DOMAIN}${canonicalJson(body)}`)}`;
}

/** Check that a plan receipt's selected deploy/external set equals the immutable manifest. */
export function assertPlanExecutionMatchesManifest(
  receipt: Record<string, unknown>,
  plan: SuccessorDeploymentPlanV1,
  manifest: DeploymentManifest,
): void {
  if (receipt.type !== 'protocol-deployment-plan-execution/v1' || receipt.planId !== plan.planId) {
    throw new ConfigError('PLAN_EXECUTION_IDENTITY_MISMATCH', 'Plan execution receipt identifies a different profile');
  }
  if (receipt.planHash !== deploymentPlanHash(plan)) throw new ConfigError('PLAN_EXECUTION_HASH_MISMATCH', 'Plan execution receipt does not match the selected plan');
  const manifestDomain = manifest.type === 'protocol-deployment-manifest/v2' ? 'protocol-deployment-manifest:v2:' : 'protocol-deployment-manifest:v1:';
  if (receipt.manifestRoot !== `0x${keccak256Hex(`${manifestDomain}${canonicalJson(manifest)}`)}`) {
    throw new ConfigError('PLAN_EXECUTION_MANIFEST_MISMATCH', 'Plan execution receipt does not bind the supplied deployment manifest');
  }
  const { planExecutionRoot: declaredRoot, ...body } = receipt;
  if (declaredRoot !== planExecutionRoot(body)) throw new ConfigError('PLAN_EXECUTION_ROOT_MISMATCH', 'Plan execution receipt root is invalid');

  const selected = receipt.selectedContracts as Array<{ logicalId: string; kind: string }> | undefined;
  if (!Array.isArray(selected)) throw new ConfigError('PLAN_EXECUTION_CONTRACTS_MISSING', 'Plan execution receipt has no selected contract projection');
  const expectedSelection = Object.entries(plan.contracts).map(([logicalId, source]) => ({ logicalId, ...source }));
  if (canonicalJson(selected) !== canonicalJson(expectedSelection)) {
    throw new ConfigError('PLAN_EXECUTION_SOURCE_MISMATCH', 'Plan execution receipt changed one or more selected dependency sources');
  }
  const selectedDeploys = selected.filter((entry) => entry.kind === 'deploy' || entry.kind === 'local-fixture').map((entry) => entry.logicalId).sort();
  const manifestDeploys = manifest.contracts.map((entry) => entry.logicalId).sort();
  if (canonicalJson(selectedDeploys) !== canonicalJson(manifestDeploys)) {
    throw new ConfigError('PLAN_EXECUTION_DEPLOYMENT_SET_MISMATCH', 'Manifest deployments differ from the plan-selected deploy/local-fixture set');
  }
  const selectedExternal = selected.filter((entry) => entry.kind === 'external').map((entry) => entry.logicalId).sort();
  const manifestExternal = manifest.type === 'protocol-deployment-manifest/v2' ? manifest.externalContracts.map((entry) => entry.logicalId).sort() : [];
  if (canonicalJson(selectedExternal) !== canonicalJson(manifestExternal)) {
    throw new ConfigError('PLAN_EXECUTION_EXTERNAL_SET_MISMATCH', 'Manifest external observations differ from the plan-selected external set');
  }
  const stageReceipts = receipt.stages as Array<{ id: string; kind: string; status: string; outputs?: Record<string, { address?: string; transactionHash?: string; blockNumber?: string; runtimeBytecodeSha256?: string }> }> | undefined;
  if (!Array.isArray(stageReceipts)) throw new ConfigError('PLAN_EXECUTION_STAGES_MISSING', 'Plan execution receipt has no stage result list');
  if (stageReceipts.length !== plan.stages.length) throw new ConfigError('PLAN_EXECUTION_STAGES_MISSING', 'Plan execution receipt has an incomplete stage result list');
  const verifiedStatus = new Map<string, string>();
  for (const stage of plan.stages) {
    const stageReceipt = stageReceipts.find((entry) => entry.id === stage.id);
    if (!stageReceipt || stageReceipt.kind !== stage.kind) throw new ConfigError('PLAN_EXECUTION_STAGE_MISMATCH', `Plan execution receipt omits or changes stage '${stage.id}'`);
    if (stageReceipt.status === 'verified' && !stage.dependsOn.every((dependency) => ['verified', 'not-applicable'].includes(verifiedStatus.get(dependency) ?? ''))) {
      throw new ConfigError('PLAN_EXECUTION_STAGE_DEPENDENCY_MISMATCH', `Stage '${stage.id}' is marked verified although a prerequisite stage is not verified`);
    }
    verifiedStatus.set(stage.id, stageReceipt.status);
    if (stage.kind === 'deploy') {
      const members = expectedSelection.filter((entry) => entry.kind === 'deploy' || entry.kind === 'local-fixture').filter((entry) => 'stage' in entry && entry.stage === stage.id);
      for (const member of members) {
        const fact = manifest.contracts.find((contract) => contract.logicalId === member.logicalId);
        const output = stageReceipt.outputs?.[member.logicalId];
        if (!fact || !output ||
            output.address?.toLowerCase() !== fact.address.toLowerCase() ||
            output.transactionHash?.toLowerCase() !== fact.deploymentTx.toLowerCase() ||
            output.blockNumber !== fact.blockNumber ||
            output.runtimeBytecodeSha256 !== fact.artifact.runtimeBytecodeSha256) {
          throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUT_MISMATCH', `Deployment stage '${stage.id}' output for '${member.logicalId}' is missing or conflicts with the immutable manifest`);
        }
      }
    } else if (stageReceipt.status === 'verified') {
      throw new ConfigError('PLAN_EXECUTION_UNSUPPORTED_STAGE_CLAIM', `Stage '${stage.id}' claims completion outside the deployment/external observation executor`);
    }
  }
}
