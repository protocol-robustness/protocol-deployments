import { createHash } from 'crypto';
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
  if (receipt.executionStatus !== 'complete' && receipt.executionStatus !== 'partial') {
    throw new ConfigError('PLAN_EXECUTION_STATUS_INVALID', 'Plan execution receipt must identify complete or partial execution');
  }
  const partialExecution = receipt.executionStatus === 'partial';
  if (!Number.isSafeInteger(receipt.chainId) || receipt.chainId !== manifest.chain.id || receipt.localOnly !== plan.localOnly ||
      typeof receipt.environment !== 'string' || receipt.environment.length === 0 ||
      !Array.isArray(receipt.selectedUnits) || !Array.isArray(receipt.excludedUnits) ||
      canonicalJson(receipt.selectedUnits) !== canonicalJson(plan.selectedUnits) ||
      canonicalJson(receipt.excludedUnits) !== canonicalJson(plan.excludedUnits)) {
    throw new ConfigError('PLAN_EXECUTION_CONTEXT_MISMATCH', 'Plan execution receipt context differs from the manifest chain or selected plan scope');
  }

  const selected = receipt.selectedContracts as Array<{ logicalId: string; kind: string }> | undefined;
  if (!Array.isArray(selected)) throw new ConfigError('PLAN_EXECUTION_CONTRACTS_MISSING', 'Plan execution receipt has no selected contract projection');
  const expectedSelection = Object.entries(plan.contracts).map(([logicalId, source]) => ({ logicalId, ...source }));
  if (canonicalJson(selected) !== canonicalJson(expectedSelection)) {
    throw new ConfigError('PLAN_EXECUTION_SOURCE_MISMATCH', 'Plan execution receipt changed one or more selected dependency sources');
  }
  const selectedDeploys = selected.filter((entry) => entry.kind === 'deploy' || entry.kind === 'local-fixture').map((entry) => entry.logicalId).sort();
  const manifestDeploys = manifest.contracts.map((entry) => entry.logicalId).sort();
  if (partialExecution
    ? manifestDeploys.some((logicalId) => !selectedDeploys.includes(logicalId))
    : canonicalJson(selectedDeploys) !== canonicalJson(manifestDeploys)) {
    throw new ConfigError('PLAN_EXECUTION_DEPLOYMENT_SET_MISMATCH', 'Manifest deployments differ from the plan-selected deploy/local-fixture set');
  }
  const selectedExternal = selected.filter((entry) => entry.kind === 'external' || entry.kind === 'stage-output').map((entry) => entry.logicalId).sort();
  const manifestExternal = manifest.type === 'protocol-deployment-manifest/v2' ? manifest.externalContracts.map((entry) => entry.logicalId).sort() : [];
  if (partialExecution
    ? manifestExternal.some((logicalId) => !selectedExternal.includes(logicalId))
    : canonicalJson(selectedExternal) !== canonicalJson(manifestExternal)) {
    throw new ConfigError('PLAN_EXECUTION_EXTERNAL_SET_MISMATCH', 'Manifest external observations differ from the plan-selected external set');
  }
  const stageOutputSources = Object.entries(plan.contracts).flatMap(([logicalId, source]) => source.kind === 'stage-output'
    ? [{ logicalId, stage: source.stage, output: source.output }]
    : []);
  const stageOutputBindings = receipt.stageOutputBindings as Array<{
    logicalId: string; stage: string; output: string; receiptRoot?: string; evidenceRoot?: string; outputRoot: string; address: string;
  }> | undefined;
  if (stageOutputSources.length > 0) {
    if (!Array.isArray(stageOutputBindings)) throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUTS_MISSING', 'Plan execution receipt omits authenticated stage-output bindings');
    const expected = [...stageOutputSources].sort((a, b) => a.logicalId.localeCompare(b.logicalId));
    const observed = stageOutputBindings.map(({ logicalId, stage, output }) => ({ logicalId, stage, output })).sort((a, b) => a.logicalId.localeCompare(b.logicalId));
    if (canonicalJson(observed) !== canonicalJson(expected) || stageOutputBindings.some((binding) => !/^0x[0-9a-f]{64}$/.test(binding.outputRoot) || !/^0x[0-9a-fA-F]{40}$/.test(binding.address))) {
      throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUTS_MISMATCH', 'Plan execution stage-output bindings do not match selected sources or contain malformed commitments');
    }
    for (const binding of stageOutputBindings) {
      const source = plan.contracts[binding.logicalId];
      const validLegacy = source?.kind === 'stage-output' && !source.producer &&
        /^0x[0-9a-f]{64}$/.test(binding.receiptRoot ?? '') && binding.evidenceRoot === undefined;
      const validCrossPlan = source?.kind === 'stage-output' && source.producer &&
        binding.receiptRoot === undefined && binding.evidenceRoot === source.producer.evidenceRoot;
      if (!validLegacy && !validCrossPlan) throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUTS_MISMATCH', `Stage-output binding '${binding.logicalId}' does not match its declared evidence type`);
    }
    if (manifest.type !== 'protocol-deployment-manifest/v2' || stageOutputBindings.some((binding) => {
      const observedContract = manifest.externalContracts.find((candidate) => candidate.logicalId === binding.logicalId);
      const source = plan.contracts[binding.logicalId];
      const producerMismatch = source?.kind === 'stage-output' && source.producer &&
        (binding.evidenceRoot !== source.producer.evidenceRoot || binding.outputRoot !== source.producer.outputRoot || binding.address.toLowerCase() !== source.producer.address.toLowerCase());
      return !observedContract || observedContract.address.toLowerCase() !== binding.address.toLowerCase() || producerMismatch;
    })) {
      throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUT_MANIFEST_MISMATCH', 'Stage-output bindings do not match the external observations in the manifest');
    }
  } else if (stageOutputBindings && stageOutputBindings.length !== 0) {
    throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUTS_UNEXPECTED', 'Execution receipt contains undeclared stage-output bindings');
  }
  const stageReceipts = receipt.stages as Array<{ id: string; kind: string; status: string; outputs?: Record<string, unknown>; evidence?: unknown }> | undefined;
  if (!Array.isArray(stageReceipts)) throw new ConfigError('PLAN_EXECUTION_STAGES_MISSING', 'Plan execution receipt has no stage result list');
  if (stageReceipts.length !== plan.stages.length) throw new ConfigError('PLAN_EXECUTION_STAGES_MISSING', 'Plan execution receipt has an incomplete stage result list');
  const manifestAssertions = manifest.finalAssertions as Array<{ id?: string; status?: string; detail?: string }> | undefined;
  const assertionEvidence = (id: string): Record<string, unknown> | undefined => {
    const assertion = manifestAssertions?.find((candidate) => candidate.id === id && candidate.status === 'passed');
    try { return assertion?.detail ? JSON.parse(assertion.detail) as Record<string, unknown> : undefined; } catch { return undefined; }
  };
  const verifiedAction = (id: string): { transactionHash?: string; blockNumber?: string } | undefined =>
    manifest.bootstrapActions.find((candidate) => candidate.id === id && candidate.status === 'verified');
  const digestText = (value: unknown): string | undefined => typeof value === 'string'
    ? createHash('sha256').update(value, 'utf8').digest('hex') : undefined;
  const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);
  const canonicalRootToHex = (value: unknown): string | undefined => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
    ? `0x${value.slice(7)}` : undefined;
  const verifiedStatus = new Map<string, string>();
  for (const stage of plan.stages) {
    const stageReceipt = stageReceipts.find((entry) => entry.id === stage.id);
    if (!stageReceipt || stageReceipt.kind !== stage.kind) throw new ConfigError('PLAN_EXECUTION_STAGE_MISMATCH', `Plan execution receipt omits or changes stage '${stage.id}'`);
    if (!['verified', 'not-applicable', 'blocked', 'pending', 'not-executed'].includes(stageReceipt.status)) {
      throw new ConfigError('PLAN_EXECUTION_STATUS_INVALID', `Plan stage '${stage.id}' has an unsupported status '${stageReceipt.status}'`);
    }
    const stageExternalMembers = expectedSelection.filter((entry) => entry.kind === 'external' && 'stage' in entry && entry.stage === stage.id);
    const mayBeNotApplicable = stage.kind === 'external-preflight' && stageExternalMembers.length === 0;
    if (stageReceipt.status === 'not-applicable' && !mayBeNotApplicable) {
      throw new ConfigError('PLAN_EXECUTION_STATUS_INVALID', `Stage '${stage.id}' cannot be marked not-applicable for this plan`);
    }
    if (!partialExecution && stageReceipt.status !== 'verified' && !mayBeNotApplicable) {
      throw new ConfigError('PLAN_EXECUTION_STATUS_INVALID', `Complete execution contains unfinished stage '${stage.id}'`);
    }
    if (stageReceipt.status === 'verified' && !stage.dependsOn.every((dependency) => ['verified', 'not-applicable'].includes(verifiedStatus.get(dependency) ?? ''))) {
      throw new ConfigError('PLAN_EXECUTION_STAGE_DEPENDENCY_MISMATCH', `Stage '${stage.id}' is marked verified although a prerequisite stage is not verified`);
    }
    verifiedStatus.set(stage.id, stageReceipt.status);
    if (stage.kind === 'deploy' && stageReceipt.status === 'verified') {
      const members = expectedSelection.filter((entry) => entry.kind === 'deploy' || entry.kind === 'local-fixture').filter((entry) => 'stage' in entry && entry.stage === stage.id);
      for (const member of members) {
        const fact = manifest.contracts.find((contract) => contract.logicalId === member.logicalId);
        const outputName = stage.contractOutputs
          ? Object.entries(stage.contractOutputs).find(([, logicalId]) => logicalId === member.logicalId)?.[0]
          : member.logicalId;
        const output = outputName ? stageReceipt.outputs?.[outputName] as {
          address?: string;
          transactionHash?: string;
          blockNumber?: string;
          runtimeBytecodeSha256?: string;
        } | undefined : undefined;
        if (!fact || !output ||
            output.address?.toLowerCase() !== fact.address.toLowerCase() ||
            output.transactionHash?.toLowerCase() !== fact.deploymentTx.toLowerCase() ||
            output.blockNumber !== fact.blockNumber ||
            output.runtimeBytecodeSha256 !== fact.artifact.runtimeBytecodeSha256) {
          throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUT_MISMATCH', `Deployment stage '${stage.id}' output for '${member.logicalId}' is missing or conflicts with the immutable manifest`);
        }
      }
      if (stage.id === 'deploy-genesis') {
        const preflight = assertionEvidence('prf-genesis-seal-preflight');
        const expectedCodeHash = preflight?.['artifact.control-plane.runtime-code-keccak256'];
        const observedCodeHash = (stageReceipt.outputs?.genesisRuntimeCodeHash as string | undefined)?.toLowerCase();
        if (typeof expectedCodeHash !== 'string' || observedCodeHash !== expectedCodeHash.toLowerCase()) {
          throw new ConfigError('PLAN_EXECUTION_STAGE_OUTPUT_MISMATCH', 'Genesis deployment runtime-code output is missing or conflicts with retained seal-preflight evidence');
        }
      }
    } else if (stage.kind === 'derive-canonical-roots' &&
        ['derive-genesis-roots', 'derive-initial-configuration'].includes(stage.id) && stageReceipt.status === 'verified') {
      const assertions = manifest.finalAssertions as Array<{ id?: string; status?: string; detail?: string }> | undefined;
      const approval = assertions?.find((assertion) => assertion.id === 'prf-initial-input-approval' && assertion.status === 'passed');
      let evidence: Record<string, unknown> | undefined;
      try { evidence = approval?.detail ? JSON.parse(approval.detail) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const expectedEvidence = evidence && {
        type: 'prf-initial-input-approval',
        manifestRoot: evidence.manifestRoot,
        verifierOutputSha256: evidence.outputSha256,
        inputSha256: Array.isArray(evidence.inputs) ? evidence.inputs.map((input) => (input as { sha256?: unknown }).sha256) : undefined,
      };
      if (!evidence || !expectedEvidence || canonicalJson(stageReceipt.evidence) !== canonicalJson(expectedEvidence)) {
        throw new ConfigError('PLAN_EXECUTION_DERIVATION_EVIDENCE_MISMATCH', `Canonical derivation stage '${stage.id}' is not bound to the retained PRF approval verification`);
      }
      const roots = evidence.approvedRootBindings as Record<string, unknown> | undefined;
      const outputs = stageReceipt.outputs as Record<string, unknown> | undefined;
      const expectedOutputs = stage.id === 'derive-genesis-roots' && roots
        ? { protocolGenesisRoot: roots.protocolGenesisRoot, authorityStateRoot: roots.authorityStateRoot, emptyRegistryRoot: roots.initialVerifierRegistryRoot }
        : stage.id === 'derive-initial-configuration' && roots
          ? { initialConfigurationRoot: roots.initialConfigurationRoot }
          : undefined;
      if (!expectedOutputs || canonicalJson(outputs) !== canonicalJson(expectedOutputs)) {
        throw new ConfigError('PLAN_EXECUTION_DERIVATION_OUTPUT_MISMATCH', `Canonical derivation stage '${stage.id}' outputs differ from approved roots`);
      }
    } else if (stage.id === 'derive-chain-instance-root' && stageReceipt.status === 'verified') {
      const assertions = manifest.finalAssertions as Array<{ id?: string; status?: string; detail?: string }> | undefined;
      const preflight = assertions?.find((assertion) => assertion.id === 'prf-genesis-seal-preflight' && assertion.status === 'passed');
      let evidence: Record<string, unknown> | undefined;
      try { evidence = preflight?.detail ? JSON.parse(preflight.detail) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const outputs = stageReceipt.outputs as Record<string, unknown> | undefined;
      if (!evidence || evidence.schema !== 'prf-chain-instance-seal-preflight.v2' ||
          canonicalJson(stageReceipt.evidence) !== canonicalJson({ type: 'prf-genesis-seal-preflight', manifestRoot: evidence.manifestRoot, verifierOutputSha256: evidence.outputSha256 }) ||
          canonicalJson(outputs) !== canonicalJson({ chainInstanceGenesisRoot: evidence.computedRoot })) {
        throw new ConfigError('PLAN_EXECUTION_GENESIS_DERIVATION_MISMATCH', 'Chain-instance root stage is not bound to retained independent seal-preflight evidence');
      }
    } else if (stage.id === 'derive-registry-roots' && stageReceipt.status === 'verified') {
      const assertions = manifest.finalAssertions as Array<{ id?: string; status?: string; detail?: string }> | undefined;
      const derivation = assertions?.find((assertion) => assertion.id === 'prf-successor-registry-derivation' && assertion.status === 'passed');
      let evidence: Record<string, unknown> | undefined;
      try { evidence = derivation?.detail ? JSON.parse(derivation.detail) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const outputs = stageReceipt.outputs as Record<string, unknown> | undefined;
      let prfOutput: Record<string, unknown> | undefined;
      try { prfOutput = typeof evidence?.output === 'string' ? JSON.parse(evidence.output) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const expectedRequestSha256 = evidence?.entry
        ? createHash('sha256').update(JSON.stringify({ schema: 'prf-verifier-registry-derivation-request.v1', entries: [evidence.entry] })).digest('hex')
        : undefined;
      const observedOutputSha256 = typeof evidence?.output === 'string'
        ? createHash('sha256').update(evidence.output, 'utf8').digest('hex')
        : undefined;
      if (!evidence || evidence.schema !== 'prf-verifier-registry-derivation-evidence.v1' ||
          evidence.qualification !== 'canonical-root-derived-and-solidity-equivalent' ||
          typeof evidence.root !== 'string' || !/^0x[0-9a-f]{64}$/.test(evidence.root) || evidence.solidityRoot !== evidence.root ||
          evidence.requestSha256 !== expectedRequestSha256 || evidence.outputSha256 !== observedOutputSha256 ||
          evidence.observationBlock === undefined || typeof evidence.observationBlock !== 'object' ||
          !/^0x[0-9a-fA-F]{64}$/.test(String((evidence.observationBlock as Record<string, unknown>).hash ?? '')) ||
          prfOutput?.schema !== 'prf-verifier-registry-derivation-result.v1' || prfOutput.root !== evidence.root ||
          canonicalJson(prfOutput.entries) !== canonicalJson([evidence.entry]) ||
          canonicalJson(stageReceipt.evidence) !== canonicalJson(evidence) ||
          canonicalJson(outputs) !== canonicalJson({ successorRegistryRoot: evidence.root })) {
        throw new ConfigError('PLAN_EXECUTION_REGISTRY_DERIVATION_MISMATCH', 'Successor registry root stage is not bound to PRF/Solidity derivation evidence');
      }
    } else if (stage.id === 'derive-successor-configuration' && stageReceipt.status === 'verified') {
      const evidence = assertionEvidence('prf-successor-configuration-derivation');
      const derivation = evidence?.derivation as Record<string, unknown> | undefined;
      const transition = derivation?.['configuration-transition'] as Record<string, unknown> | undefined;
      const outputText = evidence?.output;
      let output: Record<string, unknown> | undefined;
      try { output = typeof outputText === 'string' ? JSON.parse(outputText) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const target = transition?.target as Record<string, unknown> | undefined;
      const request = evidence?.request as Record<string, unknown> | undefined;
      const expectedRequestSha256 = request ? createHash('sha256').update(JSON.stringify(request)).digest('hex') : undefined;
      const expectedOutputs = derivation && transition && target ? {
        decisionRoot: derivation['decision-root'],
        successorConfigurationRoot: derivation['configuration/C1-root'],
        configurationEpoch: transition.epoch,
        targetRoot: target['target/root'],
      } : undefined;
      if (!evidence || evidence.schema !== 'prf-successor-configuration-evidence.v1' ||
          evidence.qualification !== 'successor-configuration-independently-derived-not-approved' ||
          !derivation || !transition || !target ||
          !Array.isArray(derivation['changed-fields']) || !same(derivation['changed-fields'], ['verifier-registry/root']) ||
          derivation['configuration/C0-root'] === derivation['configuration/C1-root'] || transition.epoch !== 1 ||
          !request || request['initial-configuration'] === undefined ||
          !same(request['initial-configuration'], derivation['configuration/C0']) ||
          request['protocol-genesis-root'] !== derivation['protocol-genesis-root'] ||
          !same(request['chain-instance-genesis'], derivation['chain-instance-genesis']) ||
          request['expected-chain-instance-genesis-root'] !== derivation['chain-instance-genesis-root'] ||
          request['expected-initial-configuration-root'] !== derivation['configuration/C0-root'] ||
          request['successor-verifier-registry-root'] !== derivation['successor-verifier-registry-root'] ||
          request['successor-proof-mode'] !== derivation['successor-proof-mode'] || request.epoch !== transition.epoch ||
          transition['configuration/parent-root'] !== derivation['configuration/C0-root'] ||
          transition['configuration/new-root'] !== derivation['configuration/C1-root'] ||
          transition['verifier-registry/root'] !== derivation['successor-verifier-registry-root'] ||
          evidence.requestSha256 !== expectedRequestSha256 ||
          evidence.outputSha256 !== digestText(outputText) || output?.schema !== 'prf-successor-configuration-derivation.v1' ||
          output.qualification !== 'derived-only-not-approved' || !same(output, derivation) || !expectedOutputs || !same(stageReceipt.outputs, expectedOutputs) ||
          !same(stageReceipt.evidence, { type: 'prf-successor-configuration-derivation', requestSha256: evidence.requestSha256,
            verifierOutputSha256: evidence.outputSha256, qualification: evidence.qualification })) {
        throw new ConfigError('PLAN_EXECUTION_SUCCESSOR_DERIVATION_MISMATCH', 'C0 to C1 stage is not bound to a hashed PRF derivation that changes only the verifier registry root');
      }
    } else if (stage.id === 'verify-successor-transition-approval' && stageReceipt.status === 'verified') {
      const evidence = assertionEvidence('prf-successor-transition-approval');
      const scope = evidence?.scope as Record<string, unknown> | undefined;
      const derivationEvidence = assertionEvidence('prf-successor-configuration-derivation');
      const derivation = derivationEvidence?.derivation as Record<string, unknown> | undefined;
      const transition = derivation?.['configuration-transition'] as Record<string, unknown> | undefined;
      const output = evidence?.output;
      let verification: Record<string, unknown> | undefined;
      try { verification = typeof output === 'string' ? JSON.parse(output) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const inputs = evidence?.inputs as Array<Record<string, unknown>> | undefined;
      const expectedEvidence = evidence && { type: 'prf-successor-transition-approval', outputSha256: evidence.outputSha256,
        inputSha256: inputs?.map((input) => input.sha256) };
      const expectedOutputs = evidence && { successorTransitionApprovalEvidence: { manifestRoot: evidence.manifestRoot, scope } };
      const expectedScope = derivation && transition ? {
        'protocol/genesis-root': derivation['protocol-genesis-root'],
        'execution/chain-id': receipt.chainId,
        'chain-instance-genesis-root': derivation['chain-instance-genesis-root'],
        'configuration/parent-root': derivation['configuration/C0-root'],
        'configuration/new-root': derivation['configuration/C1-root'],
        epoch: transition.epoch,
        'entitlement-proof-mode': derivation['successor-proof-mode'],
        qualification: 'local-only',
      } : undefined;
      if (!evidence || evidence.schema !== 'prf-successor-transition-approval-verification.v1' ||
          !scope || !derivation || !transition || !expectedScope || !same(scope, expectedScope) ||
          derivation['successor-proof-mode'] !== plan.successorProofMode ||
          verification?.valid !== true || verification.qualification !== 'authenticated-successor-transition' ||
          verification['manifest-root'] !== evidence.manifestRoot || !same(verification.scope, scope) ||
          evidence.outputSha256 !== digestText(output) || !Array.isArray(inputs) || !inputs.length ||
          inputs.some((input) => typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256 as string)) ||
          !same(stageReceipt.outputs, expectedOutputs) || !same(stageReceipt.evidence, expectedEvidence)) {
        throw new ConfigError('PLAN_EXECUTION_SUCCESSOR_APPROVAL_MISMATCH', 'Successor-transition approval stage is not bound to its retained PRF verification output and inputs');
      }
    } else if (stage.id === 'seal-empty-verifier-registry' && stageReceipt.status === 'verified') {
      const evidence = assertionEvidence('prf-empty-registry-seal-result');
      const action = verifiedAction('prf/seal-empty-verifier-registry');
      const approval = assertionEvidence('prf-initial-input-approval');
      const roots = approval?.approvedRootBindings as Record<string, unknown> | undefined;
      const expectedOutputs = evidence && action ? { emptyRegistryReceipt: {
        root: evidence.root, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
      } } : undefined;
      if (!evidence || evidence.schema !== 'prf-empty-registry-seal-result.v1' || !action || !roots ||
          evidence.root !== roots.initialVerifierRegistryRoot || evidence.computedEmptyRoot !== evidence.root ||
          evidence.transactionHash !== action.transactionHash || evidence.blockNumber !== action.blockNumber ||
          !same(stageReceipt.outputs, expectedOutputs) || !same(stageReceipt.evidence, evidence)) {
        throw new ConfigError('PLAN_EXECUTION_EMPTY_REGISTRY_SEAL_MISMATCH', 'Empty registry seal is not bound to the approved empty root, verified action, and matching Solidity projection');
      }
    } else if (stage.id === 'register-successor-verifier' && stageReceipt.status === 'verified') {
      const evidence = assertionEvidence('prf-successor-verifier-registration');
      const action = verifiedAction('prf/register-successor-verifier');
      const derivation = assertionEvidence('prf-successor-registry-derivation');
      const approval = assertionEvidence('prf-successor-transition-approval');
      const expectedOutputs = evidence && action ? { registrationReceipt: {
        registryRoot: evidence.registryRoot, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
      } } : undefined;
      if (!evidence || !action || !derivation || !approval || evidence.registryRoot !== derivation.root ||
          evidence.approvalManifestRoot !== approval.manifestRoot || evidence.transactionHash !== action.transactionHash ||
          evidence.blockNumber !== action.blockNumber || !same(evidence.entry, derivation.entry) ||
          !same(stageReceipt.outputs, expectedOutputs) || !same(stageReceipt.evidence, evidence)) {
        throw new ConfigError('PLAN_EXECUTION_SUCCESSOR_REGISTRATION_MISMATCH', 'Successor verifier registration is not bound to approved registry entries, PRF derivation and its verified transaction');
      }
    } else if (stage.id === 'seal-successor-verifier-registry' && stageReceipt.status === 'verified') {
      const evidence = assertionEvidence('prf-successor-verifier-registry-seal');
      const action = verifiedAction('prf/seal-successor-verifier-registry');
      const registration = assertionEvidence('prf-successor-verifier-registration');
      const expectedOutputs = evidence && action ? { sealedSuccessorRegistryObservation: {
        registryRoot: evidence.registryRoot, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
      } } : undefined;
      if (!evidence || !action || !registration || evidence.registryRoot !== registration.registryRoot ||
          evidence.approvalManifestRoot !== registration.approvalManifestRoot || evidence.transactionHash !== action.transactionHash ||
          evidence.blockNumber !== action.blockNumber || !same(stageReceipt.outputs, expectedOutputs) || !same(stageReceipt.evidence, evidence)) {
        throw new ConfigError('PLAN_EXECUTION_SUCCESSOR_REGISTRY_SEAL_MISMATCH', 'Successor registry seal is not bound to the registered root and verified seal transaction');
      }
    } else if (stage.kind === 'seal-genesis' && stageReceipt.status === 'verified') {
      const assertions = manifest.finalAssertions as Array<{ id?: string; status?: string; detail?: string }> | undefined;
      const result = assertions?.find((assertion) => assertion.id === 'prf-genesis-seal-result' && assertion.status === 'passed');
      let evidence: Record<string, unknown> | undefined;
      try { evidence = result?.detail ? JSON.parse(result.detail) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const action = manifest.bootstrapActions.find((candidate) => candidate.id === 'prf/seal-genesis' && candidate.status === 'verified');
      const outputs = stageReceipt.outputs as Record<string, unknown> | undefined;
      const expectedOutputs = evidence && action ? { sealedGenesisObservation: {
        chainInstanceGenesisRoot: evidence.chainInstanceGenesisRoot, transactionHash: action.transactionHash, blockNumber: action.blockNumber,
      } } : undefined;
      const expectedEvidence = evidence && { type: 'prf-genesis-seal-result', verifierOutputSha256: evidence.outputSha256, preflightOutputSha256: evidence.preflightOutputSha256 };
      if (!evidence || evidence.schema !== 'prf-chain-instance-seal-result.v1' || !action ||
          canonicalJson(stageReceipt.evidence) !== canonicalJson(expectedEvidence) || canonicalJson(outputs) !== canonicalJson(expectedOutputs)) {
        throw new ConfigError('PLAN_EXECUTION_GENESIS_SEAL_MISMATCH', 'Genesis seal stage is not bound to its verified action and independent result evidence');
      }
    } else if (stage.id === 'authorize-successor-configuration' && stageReceipt.status === 'verified') {
      const evidence = assertionEvidence('prf-authority-transition-application');
      const action = verifiedAction('prf/apply-successor-authority-transition');
      const authorityEvidence = evidence?.authorityEvidence as Record<string, unknown> | undefined;
      const scope = authorityEvidence?.scope as Record<string, unknown> | undefined;
      const outputText = authorityEvidence?.output;
      let output: Record<string, unknown> | undefined;
      try { output = typeof outputText === 'string' ? JSON.parse(outputText) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const expectedOutputs = evidence && action ? { authorityTransitionReceipt: {
        transactionHash: action.transactionHash, blockNumber: action.blockNumber,
      }, successorAuthorityStateRoot: evidence.successorRoot } : undefined;
      const transitionApproval = assertionEvidence('prf-successor-transition-approval');
      const initialApproval = assertionEvidence('prf-initial-input-approval');
      const derivationEvidence = assertionEvidence('prf-successor-configuration-derivation');
      const derivation = derivationEvidence?.derivation as Record<string, unknown> | undefined;
      const transition = derivation?.['configuration-transition'] as Record<string, unknown> | undefined;
      const bindings = initialApproval?.approvedRootBindings as Record<string, unknown> | undefined;
      const registryDerivation = assertionEvidence('prf-successor-registry-derivation');
      const previousConfiguration = canonicalRootToHex(derivation?.['configuration/C0-root']);
      const newConfiguration = canonicalRootToHex(derivation?.['configuration/C1-root']);
      const previousRegistry = typeof bindings?.initialVerifierRegistryRoot === 'string'
        ? String(bindings.initialVerifierRegistryRoot).toLowerCase() : undefined;
      const newRegistry = canonicalRootToHex(derivation?.['successor-verifier-registry-root']);
      const decisionRoot = canonicalRootToHex(derivation?.['decision-root']);
      const authorityAddress = manifest.contracts.find((contract) => contract.logicalId === 'prf/governance-authority')?.address;
      const expectedScope = derivation && bindings ? {
        'chain-instance-genesis-root': derivation['chain-instance-genesis-root'],
        'adapter-address': authorityAddress?.toLowerCase(),
        'previous-root': `sha256:${String(bindings.authorityStateRoot).replace(/^0x/, '')}`,
        'policy-root': `sha256:${String(bindings.localAuthorityPolicyRoot).replace(/^0x/, '')}`,
        'decision-root': derivation['decision-root'],
        'transition-root': derivation['decision-root'],
        'previous-revision': 0,
        'successor-revision': 1,
      } : undefined;
      const selectedScope = scope && expectedScope
        ? Object.fromEntries(Object.keys(expectedScope).map((key) => [key, scope[key]])) : undefined;
      const mutations = output?.mutations as Array<Record<string, unknown>> | undefined;
      const authoriseMutation = mutations?.filter((mutation) => mutation.kind === 0) ?? [];
      const proofModeMutation = mutations?.filter((mutation) => mutation.kind === 2) ?? [];
      const authorise = authoriseMutation[0];
      const proofMode = proofModeMutation[0];
      const expectedEvidence = evidence && authorityEvidence ? {
        type: 'prf-authority-transition-application', approvalManifestRoot: evidence.approvalManifestRoot,
        previousRoot: evidence.previousRoot, previousRevision: evidence.previousRevision,
        successorRoot: evidence.successorRoot, successorRevision: evidence.successorRevision,
        scope, decisionPreimagesRoot: authorityEvidence.decisionPreimagesRoot,
        executionMutationRoot: authorityEvidence.executionMutationRoot, verifierOutputSha256: authorityEvidence.outputSha256,
      } : undefined;
      if (!evidence || !action || !authorityEvidence || !scope || !expectedOutputs || !expectedEvidence ||
          authorityEvidence.schema !== 'prf-authority-transition-verification.v1' || !derivation || !transition || !bindings ||
          !transitionApproval || !registryDerivation ||
          authorityEvidence.outputSha256 !== digestText(outputText) || output?.valid !== true ||
          output.qualification !== 'authenticated-authority-transition' ||
          !same(output.scope, scope) || !same(output.mutations, authorityEvidence.mutations) ||
          !same(output['decision-preimages-root'], authorityEvidence.decisionPreimagesRoot) ||
          !same(output['execution-mutation-root'], authorityEvidence.executionMutationRoot) ||
          !same(output.attestation, authorityEvidence.attestation) || !same(selectedScope, expectedScope) ||
          scope['previous-root'] === undefined || canonicalRootToHex(scope['successor-root']) !== evidence.successorRoot ||
          scope['previous-revision'] !== 0 || scope['successor-revision'] !== 1 ||
          scope['chain-instance-genesis-root'] !== derivation['chain-instance-genesis-root'] ||
          scope['decision-root'] !== derivation['decision-root'] || scope['transition-root'] !== derivation['decision-root'] ||
          scope['policy-root'] !== `sha256:${String(bindings.localAuthorityPolicyRoot).replace(/^0x/, '')}` ||
          scope['previous-root'] !== `sha256:${String(bindings.authorityStateRoot).replace(/^0x/, '')}` ||
          !Array.isArray(mutations) || mutations.length !== 2 || authoriseMutation.length !== 1 || proofModeMutation.length !== 1 ||
          !authorise || !proofMode || !previousConfiguration || !newConfiguration || !previousRegistry || !newRegistry || !decisionRoot ||
          authorise.decisionRoot !== decisionRoot || authorise.targetMode !== 0 ||
          authorise.targetRoot !== canonicalRootToHex(derivation['chain-instance-genesis-root']) ||
          authorise.parentConfigurationRoot !== previousConfiguration || authorise.newConfigurationRoot !== newConfiguration ||
          authorise.parentVerifierRegistryRoot !== previousRegistry || authorise.newVerifierRegistryRoot !== newRegistry || authorise.epoch !== 1 ||
          proofMode.decisionRoot !== decisionRoot || proofMode.proofMode !== plan.successorProofMode ||
          newRegistry !== registryDerivation.root ||
          evidence.approvalManifestRoot !== transitionApproval.manifestRoot ||
          scope['successor-root'] !== `sha256:${String(evidence.successorRoot).replace(/^0x/, '')}` ||
          output['decision-preimages-root'] !== authorityEvidence.decisionPreimagesRoot ||
          output['execution-mutation-root'] !== authorityEvidence.executionMutationRoot ||
          output.attestation !== authorityEvidence.attestation ||
          evidence.previousRevision !== 0 || evidence.successorRevision !== 1 ||
          evidence.transactionHash !== action.transactionHash || evidence.blockNumber !== action.blockNumber ||
          !same(stageReceipt.outputs, expectedOutputs) || !same(stageReceipt.evidence, expectedEvidence)) {
        throw new ConfigError('PLAN_EXECUTION_AUTHORITY_TRANSITION_MISMATCH', 'Authority transition stage is not bound to a PRF-verified transition, one-step revision and verified application transaction');
      }
    } else if (stage.id === 'apply-successor-configuration' && stageReceipt.status === 'verified') {
      const evidence = assertionEvidence('prf-successor-configuration-application');
      const action = verifiedAction('prf/apply-successor-configuration');
      const derivationEvidence = assertionEvidence('prf-successor-configuration-derivation');
      const derivation = derivationEvidence?.derivation as Record<string, unknown> | undefined;
      const approval = assertionEvidence('prf-successor-transition-approval');
      let transitionApproval: Record<string, unknown> | undefined;
      try { transitionApproval = typeof evidence?.transitionApproval === 'string' ? JSON.parse(evidence.transitionApproval) as Record<string, unknown> : undefined; } catch { /* rejected below */ }
      const registrySeal = assertionEvidence('prf-successor-verifier-registry-seal');
      const expectedOutputs = evidence && action ? {
        configurationTransitionReceipt: { transactionHash: action.transactionHash, blockNumber: action.blockNumber },
        activeConfigurationRoot: evidence.configurationRoot, activeConfigurationEpoch: evidence.epoch,
        activeEntitlementProofMode: evidence.entitlementProofMode,
      } : undefined;
      const expectedEvidence = evidence ? { type: 'prf-successor-configuration-application', decisionRoot: evidence.decisionRoot,
        configurationRoot: evidence.configurationRoot, verifierRegistryRoot: evidence.verifierRegistryRoot,
        epoch: evidence.epoch, entitlementProofMode: evidence.entitlementProofMode, consumed: evidence.consumed } : undefined;
      if (!evidence || !action || !derivation || !approval || !registrySeal || evidence.consumed !== true ||
          evidence.epoch !== 1 || evidence.configurationRoot !== canonicalRootToHex(derivation['configuration/C1-root']) ||
          evidence.decisionRoot !== canonicalRootToHex(derivation['decision-root']) ||
          evidence.verifierRegistryRoot !== canonicalRootToHex(derivation['successor-verifier-registry-root']) ||
          transitionApproval?.manifestRoot !== approval.manifestRoot || evidence.verifierRegistryRoot !== registrySeal.registryRoot ||
          registrySeal.approvalManifestRoot !== approval.manifestRoot ||
          evidence.entitlementProofMode !== plan.successorProofMode ||
          evidence.transactionHash !== action.transactionHash || evidence.blockNumber !== action.blockNumber ||
          !same(stageReceipt.outputs, expectedOutputs) || !same(stageReceipt.evidence, expectedEvidence)) {
        throw new ConfigError('PLAN_EXECUTION_SUCCESSOR_CONFIGURATION_MISMATCH', 'C1 application is not bound to the approved derivation, sealed verifier registry, consumed decision and verified transaction');
      }
    } else if (stageReceipt.status === 'verified') {
      throw new ConfigError('PLAN_EXECUTION_UNSUPPORTED_STAGE_CLAIM', `Stage '${stage.id}' claims completion outside the deployment/external observation executor`);
    }
  }
}
