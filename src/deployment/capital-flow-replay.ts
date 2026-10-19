import { createHash } from 'crypto';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, keccak256, toBytes, toEventSelector, toFunctionSelector, type Abi, type AbiEvent, type AbiFunction } from 'viem';
import { canonicalJson } from '../canonical-json';
import { ConfigError } from '../errors';
import type { RpcTransport } from '../runtime/transport';
import type { ResolvedSpec } from '../canonical';
import type { DeploymentManifest } from './manifest';

export const CAPITAL_FLOW_POSITIVE_STEPS = [
  'operation-preparation',
  'statement-admission',
  'assurance-preparation',
  'ratification-and-funding',
  'entitlement-activation',
  'entitlement-withdrawal',
] as const;

export const CAPITAL_FLOW_NEGATIVE_CASES = [
  'wrong-proof',
  'verifier-substitution',
  'wrong-instance',
  'stale-c0-admission',
  'stale-c0-assurance',
  'wrong-operation',
  'unauthorized-configuration-route',
  'repeated-admission',
  'repeated-ratification',
  'repeated-withdrawal',
] as const;

/** Required transaction chronology so each negative action exercises its intended boundary. */
export const CAPITAL_FLOW_EXECUTION_ORDER = [
  'unauthorized-configuration-route',
  'wrong-instance',
  'operation-preparation',
  'stale-c0-admission',
  'stale-c0-assurance',
  'wrong-proof',
  'verifier-substitution',
  'statement-admission',
  'repeated-admission',
  'assurance-preparation',
  'wrong-operation',
  'ratification-and-funding',
  'repeated-ratification',
  'entitlement-activation',
  'entitlement-withdrawal',
  'repeated-withdrawal',
] as const;

export const CAPITAL_FLOW_EXPECTED_STATUSES: Record<string, 'success' | 'reverted'> = {
  'operation-preparation': 'success',
  'statement-admission': 'success',
  'assurance-preparation': 'success',
  'ratification-and-funding': 'success',
  'entitlement-activation': 'success',
  'entitlement-withdrawal': 'success',
  'wrong-proof': 'reverted',
  'verifier-substitution': 'reverted',
  'wrong-instance': 'reverted',
  'stale-c0-admission': 'success',
  'stale-c0-assurance': 'reverted',
  'wrong-operation': 'reverted',
  'unauthorized-configuration-route': 'reverted',
  // Generic admission is identity-replayable; capital-bound state must remain unchanged.
  'repeated-admission': 'success',
  'repeated-ratification': 'reverted',
  'repeated-withdrawal': 'reverted',
};

type FlowStep = { id: string; transactionHash: string; to: string; selector: string };
type StateAssertion = { actionId: string; domain: string; logicalId: string; contract: string; callData: string; expectedBefore: string; expectedAfter: string };
type FlowEvidence = {
  schema: 'protocol-capital-flow-execution/v5';
  chainId: number;
  chainInstanceGenesisRoot: string;
  configurationRoot: string;
  configurationEpoch: number;
  operationId: string;
  admissionReceiptId: string;
  preparedOperationRoot: string;
  staleC0OperationRoot: string;
  staleC0Operation: string[];
  staleC0AdmissionReceiptId: string;
  reserveStateCommitment: string;
  statementRoot: string;
  verifierId: string;
  publicValuesSha256: string;
  positiveTransactions: FlowStep[];
  negativeTransactions: FlowStep[];
  stateAssertions: StateAssertion[];
};
type CapitalFlowExpectations = {
  schema: 'protocol-capital-flow-expectations/v2';
  manifestRoot: string;
  chainInstanceGenesisRoot: string;
  configurationRoot: string;
  configurationEpoch: number;
  operationId: string;
  operationExecutor: {
    address: string;
    operator: string;
    operationId: string;
    controller: string;
    representation: string;
    sourceSha256: string;
    artifactSha256: string;
    runtimeCodeKeccak256: string;
    representationArtifactSha256: string;
    representationRuntimeCodeKeccak256: string;
  };
  stateAssertions: StateAssertion[];
};

/** ABI of the pinned local-only one-operation executor in PRF-EVM. */
export const LOCAL_ENTITLEMENT_OPERATOR_ABI: Abi = [
  { type: 'function', name: 'activate', stateMutability: 'nonpayable', inputs: [{ name: 'representation', type: 'address' }], outputs: [] },
  { type: 'function', name: 'controller', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'fund', stateMutability: 'nonpayable', inputs: [{ name: 'commitment', type: 'bytes32' }, { name: 'residualRecipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'operationId', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'operator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'refund', stateMutability: 'nonpayable', inputs: [], outputs: [] },
];

const LOCAL_OPERATOR_SOURCE_SHA256 = '49b2278666afca559d8690a47b39456fa38a5282b581a825ceab7981c2007a5c';
const LOCAL_OPERATOR_ARTIFACT_SHA256 = '2bd343ba5a78e886cce8945202bb10bdadcd60bcf4f38750ffd76e8d4d0088fc';
const ENTITLEMENT_REPRESENTATION_ARTIFACT_SHA256 = '8e172f5b1530117db25efd64cdbf822903ddc0d11d8d0578232f4e7b1f0c2148';

const isHash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const isSelector = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{8}$/i.test(value);
const isBytes = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(value);

export const CAPITAL_FLOW_ASSERTION_DOMAINS: Record<string, readonly string[]> = {
  'operation-preparation': ['prepared-operation-root', 'prepared-operation-state', 'configuration-state', 'configuration-epoch'],
  'statement-admission': ['admission-receipt', 'configuration-state', 'configuration-epoch'],
  'assurance-preparation': ['assurance-state', 'configuration-state', 'configuration-epoch'],
  'ratification-and-funding': ['reserve-state', 'liability', 'token-balance', 'consumed-assurance', 'operation-state', 'configuration-state', 'configuration-epoch'],
  'entitlement-activation': ['operation-state', 'configuration-state', 'configuration-epoch'],
  'entitlement-withdrawal': ['token-balance', 'liability', 'claim-state', 'consumed-claim', 'configuration-state', 'configuration-epoch'],
  'wrong-proof': ['admission-receipt', 'configuration-state', 'configuration-epoch'],
  'verifier-substitution': ['admission-receipt', 'configuration-state', 'configuration-epoch'],
  'wrong-instance': ['prepared-operation-root', 'prepared-operation-state', 'configuration-state', 'configuration-epoch'],
  'stale-c0-admission': ['admission-receipt', 'reserve-state', 'liability', 'token-balance', 'consumed-assurance', 'configuration-state', 'configuration-epoch'],
  'stale-c0-assurance': ['assurance-state', 'reserve-state', 'liability', 'token-balance', 'consumed-assurance', 'configuration-state', 'configuration-epoch'],
  'wrong-operation': ['assurance-state', 'operation-state', 'reserve-state', 'liability', 'token-balance', 'consumed-assurance', 'configuration-state', 'configuration-epoch'],
  'unauthorized-configuration-route': ['configuration-state', 'configuration-epoch', 'authority-state', 'decision-authorization', 'decision-proof-mode'],
  'repeated-admission': ['admission-receipt', 'reserve-state', 'liability', 'token-balance', 'consumed-assurance', 'configuration-state', 'configuration-epoch'],
  'repeated-ratification': ['reserve-state', 'liability', 'token-balance', 'consumed-assurance', 'operation-state', 'configuration-state', 'configuration-epoch'],
  'repeated-withdrawal': ['reserve-state', 'liability', 'token-balance', 'claim-state', 'consumed-claim', 'operation-state', 'configuration-state', 'configuration-epoch'],
};

export const CAPITAL_FLOW_ACTION_CALLS: Record<string, { logicalId: string; functionName: string }> = {
  'operation-preparation': { logicalId: 'shortfall/prepared-operation-controller-v2', functionName: 'prepareEntitlementOperation' },
  'statement-admission': { logicalId: 'prf/statement-admission', functionName: 'admitStatement' },
  'assurance-preparation': { logicalId: 'shortfall/source-bound-entitlement-assurance-v1', functionName: 'prepareSourceAssurance' },
  'ratification-and-funding': { logicalId: 'local/operation-scoped-entitlement-operator-v1', functionName: 'fund' },
  'entitlement-activation': { logicalId: 'local/operation-scoped-entitlement-operator-v1', functionName: 'activate' },
  'entitlement-withdrawal': { logicalId: 'shortfall/pro-rata-allocator-v2', functionName: 'withdraw' },
  'wrong-proof': { logicalId: 'prf/statement-admission', functionName: 'admitStatement' },
  'verifier-substitution': { logicalId: 'prf/statement-admission', functionName: 'admitStatement' },
  'wrong-instance': { logicalId: 'shortfall/prepared-operation-controller-v2', functionName: 'prepareEntitlementOperation' },
  'stale-c0-admission': { logicalId: 'prf/statement-admission', functionName: 'admitStatement' },
  'stale-c0-assurance': { logicalId: 'shortfall/source-bound-entitlement-assurance-v1', functionName: 'prepareSourceAssurance' },
  'wrong-operation': { logicalId: 'shortfall/source-bound-entitlement-assurance-v1', functionName: 'prepareSourceAssurance' },
  'unauthorized-configuration-route': { logicalId: 'prf/configuration-executor', functionName: 'applyConfiguration' },
  'repeated-admission': { logicalId: 'prf/statement-admission', functionName: 'admitStatement' },
  'repeated-ratification': { logicalId: 'local/operation-scoped-entitlement-operator-v1', functionName: 'fund' },
  'repeated-withdrawal': { logicalId: 'shortfall/pro-rata-allocator-v2', functionName: 'withdraw' },
};

export const CAPITAL_FLOW_STATE_CALLS: Record<string, { logicalId: string; functionName: string }> = {
  'prepared-operation-root': { logicalId: 'shortfall/prepared-operation-controller-v2', functionName: 'preparedOperationRoot' },
  'prepared-operation-state': { logicalId: 'shortfall/prepared-operation-controller-v2', functionName: 'state' },
  'admission-receipt': { logicalId: 'prf/statement-admission', functionName: 'admissionReceipt' },
  'assurance-state': { logicalId: 'shortfall/source-bound-entitlement-assurance-v1', functionName: 'preparedAssurance' },
  'reserve-state': { logicalId: 'shortfall/shortfall-reserve-v2', functionName: 'economicState' },
  liability: { logicalId: 'shortfall/pro-rata-allocator-v2', functionName: 'outstandingLiability' },
  'token-balance': { logicalId: 'prf/local-token', functionName: 'balanceOf' },
  'consumed-assurance': { logicalId: 'shortfall/source-bound-entitlement-assurance-v1', functionName: 'consumedAssurance' },
  'operation-state': { logicalId: 'shortfall/pro-rata-allocator-v2', functionName: 'entitlementOperation' },
  'claim-state': { logicalId: 'shortfall/pro-rata-allocator-v2', functionName: 'claimedCount' },
  'consumed-claim': { logicalId: 'shortfall/pro-rata-allocator-v2', functionName: 'consumedClaimIdentity' },
  'configuration-state': { logicalId: 'prf/configuration-executor', functionName: 'currentConfigurationRoot' },
  'configuration-epoch': { logicalId: 'prf/configuration-executor', functionName: 'currentEpoch' },
  'authority-state': { logicalId: 'prf/governance-authority', functionName: 'authorityStateRoot' },
  'decision-authorization': { logicalId: 'prf/governance-authority', functionName: 'getDecisionAuthorization' },
  'decision-proof-mode': { logicalId: 'prf/governance-authority', functionName: 'hasDecisionProofMode' },
};

const entitlementRatificationControllerAbi = (spec: ResolvedSpec): Abi =>
  spec.contracts['shortfall/entitlement-ratification-controller-v1']?.artifact.abi as Abi;

export function assertCapitalFlowExecutionComplete(status: unknown): void {
  if (status !== 'complete') throw new ConfigError('CAPITAL_FLOW_EXECUTION_INCOMPLETE', 'Capital-flow evidence requires a complete execution receipt with applied C1');
}

function parseEvidence(value: unknown): FlowEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', 'Capital-flow evidence must be an object');
  const evidence = value as Partial<FlowEvidence>;
  const checkSteps = (steps: unknown, expected: readonly string[]): steps is FlowStep[] =>
    Array.isArray(steps) && steps.length === expected.length && steps.every((step, i) =>
      !!step && typeof step === 'object' && !Array.isArray(step) &&
      (step as FlowStep).id === expected[i] && isHash((step as FlowStep).transactionHash) &&
      isAddress((step as FlowStep).to) && isSelector((step as FlowStep).selector));
  const keys = ['schema', 'chainId', 'chainInstanceGenesisRoot', 'configurationRoot', 'configurationEpoch', 'operationId', 'admissionReceiptId', 'preparedOperationRoot', 'staleC0OperationRoot', 'staleC0Operation', 'staleC0AdmissionReceiptId', 'reserveStateCommitment', 'statementRoot', 'verifierId', 'publicValuesSha256', 'positiveTransactions', 'negativeTransactions', 'stateAssertions'].sort();
  if (canonicalJson(Object.keys(evidence).sort()) !== canonicalJson(keys) ||
      evidence.schema !== 'protocol-capital-flow-execution/v5' ||
      !Number.isSafeInteger(evidence.chainId) || (evidence.chainId ?? 0) <= 0 ||
      !isHash(evidence.chainInstanceGenesisRoot) ||
      !isHash(evidence.configurationRoot) || !Number.isSafeInteger(evidence.configurationEpoch) || (evidence.configurationEpoch ?? 0) <= 0 ||
      !isHash(evidence.operationId) || !isHash(evidence.admissionReceiptId) || !isHash(evidence.preparedOperationRoot) ||
      !isHash(evidence.staleC0OperationRoot) || !isHash(evidence.staleC0AdmissionReceiptId) ||
      !Array.isArray(evidence.staleC0Operation) || evidence.staleC0Operation.length !== 19 || evidence.staleC0Operation.some((word) => !isHash(word)) ||
      !isHash(evidence.reserveStateCommitment) || !isHash(evidence.statementRoot) || !isHash(evidence.verifierId) || !isHash(evidence.publicValuesSha256) ||
      !checkSteps(evidence.positiveTransactions, CAPITAL_FLOW_POSITIVE_STEPS) ||
      !checkSteps(evidence.negativeTransactions, CAPITAL_FLOW_NEGATIVE_CASES) ||
      !Array.isArray(evidence.stateAssertions) || evidence.stateAssertions.some((assertion) =>
        !assertion || typeof assertion !== 'object' || Array.isArray(assertion) ||
        canonicalJson(Object.keys(assertion).sort()) !== canonicalJson(['actionId', 'domain', 'logicalId', 'contract', 'callData', 'expectedBefore', 'expectedAfter'].sort()) ||
        typeof assertion.actionId !== 'string' || !Object.hasOwn(CAPITAL_FLOW_ASSERTION_DOMAINS, assertion.actionId) ||
        typeof assertion.domain !== 'string' || !CAPITAL_FLOW_ASSERTION_DOMAINS[assertion.actionId]?.includes(assertion.domain) ||
        typeof assertion.logicalId !== 'string' || assertion.logicalId !== CAPITAL_FLOW_STATE_CALLS[assertion.domain]?.logicalId ||
        !isAddress(assertion.contract) || !isBytes(assertion.callData) || !isBytes(assertion.expectedBefore) || !isBytes(assertion.expectedAfter))) {
    throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', 'Capital-flow evidence schema, ordered step set, or transaction identity is invalid');
  }
  const hashes = [...evidence.positiveTransactions, ...evidence.negativeTransactions].map((step) => step.transactionHash.toLowerCase());
  if (new Set(hashes).size !== hashes.length) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', 'Each capital-flow action must identify a distinct transaction');
  const expectedAssertions = Object.entries(CAPITAL_FLOW_ASSERTION_DOMAINS).flatMap(([actionId, domains]) => domains.map((domain) => `${actionId}\0${domain}`)).sort();
  const actualAssertions = evidence.stateAssertions.map((assertion) => `${assertion.actionId}\0${assertion.domain}`).sort();
  if (canonicalJson(expectedAssertions) !== canonicalJson(actualAssertions)) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', 'Capital-flow evidence must include exactly one state assertion for each required action domain');
  const assertionKeys = evidence.stateAssertions.map((assertion) => `${assertion.actionId}\0${assertion.domain}`);
  if (new Set(assertionKeys).size !== assertionKeys.length) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', 'Capital-flow state assertion action/domain pairs must be unique');
  return evidence as FlowEvidence;
}

function assertCapitalFlowExpectations(
  value: unknown,
  evidence: FlowEvidence,
  expectedManifestRoot: string,
  expectedChainInstanceGenesisRoot: string,
  expectedConfigurationRoot: string,
  expectedConfigurationEpoch: number,
  manifest: DeploymentManifest,
): { digest: string; value: CapitalFlowExpectations } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('CAPITAL_FLOW_EXPECTATIONS_INVALID', 'Capital-flow expectations must come from the separately selected trusted-context package');
  }
  const expectations = value as Partial<CapitalFlowExpectations>;
  const keys = ['schema', 'manifestRoot', 'chainInstanceGenesisRoot', 'configurationRoot', 'configurationEpoch', 'operationId', 'operationExecutor', 'stateAssertions'].sort();
  const executor = expectations.operationExecutor;
  const ratificationController = manifest.contracts.find((contract) => contract.logicalId === 'shortfall/entitlement-ratification-controller-v1')?.address;
  const executorKeys = ['address', 'operator', 'operationId', 'controller', 'representation', 'sourceSha256', 'artifactSha256', 'runtimeCodeKeccak256', 'representationArtifactSha256', 'representationRuntimeCodeKeccak256'].sort();
  if (canonicalJson(Object.keys(expectations).sort()) !== canonicalJson(keys) ||
      expectations.schema !== 'protocol-capital-flow-expectations/v2' ||
      !isHash(expectedManifestRoot) || expectations.manifestRoot?.toLowerCase() !== expectedManifestRoot.toLowerCase() ||
      expectations.chainInstanceGenesisRoot?.toLowerCase() !== expectedChainInstanceGenesisRoot.toLowerCase() ||
      expectations.configurationRoot?.toLowerCase() !== expectedConfigurationRoot.toLowerCase() ||
      expectations.configurationEpoch !== expectedConfigurationEpoch ||
      expectations.operationId?.toLowerCase() !== evidence.operationId.toLowerCase() ||
      !executor || typeof executor !== 'object' ||
      canonicalJson(Object.keys(executor).sort()) !== canonicalJson(executorKeys) ||
      !isAddress(executor.address) || !isAddress(executor.operator) || !isHash(executor.operationId) ||
      executor.operationId.toLowerCase() !== evidence.operationId.toLowerCase() ||
      !isAddress(executor.controller) || !isAddress(executor.representation) ||
      !isHash(executor.runtimeCodeKeccak256) || !isHash(executor.representationRuntimeCodeKeccak256) ||
      executor.sourceSha256 !== LOCAL_OPERATOR_SOURCE_SHA256 ||
      executor.artifactSha256 !== LOCAL_OPERATOR_ARTIFACT_SHA256 ||
      executor.representationArtifactSha256 !== ENTITLEMENT_REPRESENTATION_ARTIFACT_SHA256 ||
      !isAddress(ratificationController) || executor.controller.toLowerCase() !== ratificationController.toLowerCase() ||
      !Array.isArray(expectations.stateAssertions) ||
      canonicalJson(expectations.stateAssertions) !== canonicalJson(evidence.stateAssertions)) {
    throw new ConfigError('CAPITAL_FLOW_EXPECTATIONS_MISMATCH', 'Producer-supplied historical state values differ from the independent expectation package bound to this manifest, instance, C1 and operation');
  }
  return {
    digest: createHash('sha256').update(canonicalJson(expectations), 'utf8').digest('hex'),
    value: expectations as CapitalFlowExpectations,
  };
}

function assertActionCalls(evidence: FlowEvidence, manifest: DeploymentManifest, spec: ResolvedSpec, executor: CapitalFlowExpectations['operationExecutor']): void {
  for (const step of [...evidence.positiveTransactions, ...evidence.negativeTransactions]) {
    const expected = CAPITAL_FLOW_ACTION_CALLS[step.id];
    if (!expected) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', `Capital-flow action '${step.id}' has no verifier call binding`);
    const isOperationExecutor = expected.logicalId === 'local/operation-scoped-entitlement-operator-v1';
    const deployed = isOperationExecutor ? { address: executor.address } : manifest.contracts.find((contract) => contract.logicalId === expected.logicalId);
    const resolved = spec.contracts[expected.logicalId];
    const abi = isOperationExecutor ? LOCAL_ENTITLEMENT_OPERATOR_ABI : resolved?.artifact.abi as Abi | undefined;
    const functions = abi?.filter((item): item is AbiFunction => item.type === 'function' && item.name === expected.functionName) ?? [];
    const selectors = functions.map((fn) => toFunctionSelector(fn).toLowerCase());
    if (!deployed || !selectors.includes(step.selector.toLowerCase()) || deployed.address.toLowerCase() !== step.to.toLowerCase()) {
      throw new ConfigError('CAPITAL_FLOW_CALL_MISMATCH', `Capital-flow action ${step.id} does not target the pinned contract function for this topology`);
    }
  }
  for (const assertion of evidence.stateAssertions) {
    const expected = CAPITAL_FLOW_STATE_CALLS[assertion.domain];
    if (!expected) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', `State domain '${assertion.domain}' has no verifier call binding`);
    const deployed = manifest.contracts.find((contract) => contract.logicalId === expected.logicalId);
    const resolved = spec.contracts[expected.logicalId];
    const abi = resolved?.artifact.abi as Abi | undefined;
    const functions = abi?.filter((item): item is AbiFunction => item.type === 'function' && item.name === expected.functionName &&
      (item.stateMutability === 'view' || item.stateMutability === 'pure')) ?? [];
    const selectors = functions.map((fn) => toFunctionSelector(fn).toLowerCase());
    if (!deployed || assertion.logicalId !== expected.logicalId || deployed.address.toLowerCase() !== assertion.contract.toLowerCase() ||
        !selectors.includes(assertion.callData.slice(0, 10).toLowerCase())) {
      throw new ConfigError('CAPITAL_FLOW_STATE_CALL_MISMATCH', `State assertion ${assertion.actionId}/${assertion.domain} does not use its pinned view function and deployment`);
    }
  }
}

function assertCanonicalActionInput(step: FlowStep, input: string, spec: ResolvedSpec): void {
  const expected = CAPITAL_FLOW_ACTION_CALLS[step.id];
  if (!expected) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', `Capital-flow action '${step.id}' has no canonical ABI binding`);
  const abi = expected.logicalId === 'local/operation-scoped-entitlement-operator-v1'
    ? LOCAL_ENTITLEMENT_OPERATOR_ABI
    : spec.contracts[expected.logicalId]?.artifact.abi as Abi | undefined;
  const candidates = abi?.filter((item): item is AbiFunction => item.type === 'function' && item.name === expected.functionName &&
    toFunctionSelector(item).toLowerCase() === step.selector.toLowerCase()) ?? [];
  if (candidates.length !== 1) throw new ConfigError('CAPITAL_FLOW_CALL_MISMATCH', `Capital-flow action ${step.id} does not resolve to one pinned ABI function`);
  try {
    const functionAbi = candidates[0]!;
    const decoded = decodeFunctionData({ abi: [functionAbi], data: input as `0x${string}` });
    const canonical = encodeFunctionData({ abi: [functionAbi], functionName: decoded.functionName, args: decoded.args } as never);
    if (canonical.toLowerCase() !== input.toLowerCase()) throw new Error('noncanonical action calldata');
  } catch {
    throw new ConfigError('CAPITAL_FLOW_CALL_MISMATCH', `Capital-flow action ${step.id} calldata is not canonical for its pinned ABI`);
  }
}

function calldataWord(data: string, index: number): string {
  const word = data.slice(10 + index * 64, 10 + (index + 1) * 64);
  return word.length === 64 ? `0x${word.toLowerCase()}` : '';
}

function calldataBytes(data: string, index: number): string {
  const args = data.slice(10);
  const offsetWord = args.slice(index * 64, (index + 1) * 64);
  if (offsetWord.length !== 64) return '';
  const offset = Number(BigInt(`0x${offsetWord}`));
  if (!Number.isSafeInteger(offset) || offset < 0) return '';
  const lengthWord = args.slice(offset * 2, offset * 2 + 64);
  if (lengthWord.length !== 64) return '';
  const length = Number(BigInt(`0x${lengthWord}`));
  if (!Number.isSafeInteger(length) || length < 0) return '';
  const value = args.slice(offset * 2 + 64, offset * 2 + 64 + length * 2);
  return value.length === length * 2 ? `0x${value.toLowerCase()}` : '';
}

function withdrawalIdentity(data: string): { beneficiary: string; amount: bigint; index: bigint; claimIdentityHash: string } | undefined {
  const args = data.slice(10);
  const tupleOffsetWord = args.slice(64, 128);
  if (tupleOffsetWord.length !== 64) return undefined;
  const tupleOffset = Number(BigInt(`0x${tupleOffsetWord}`));
  if (!Number.isSafeInteger(tupleOffset) || tupleOffset < 0) return undefined;
  const tupleStart = tupleOffset * 2;
  const indexWord = args.slice(tupleStart, tupleStart + 64);
  const claimOffsetWord = args.slice(tupleStart + 64, tupleStart + 128);
  const beneficiaryWord = args.slice(tupleStart + 128, tupleStart + 192);
  const amountWord = args.slice(tupleStart + 192, tupleStart + 256);
  if (indexWord.length !== 64 || claimOffsetWord.length !== 64 || beneficiaryWord.length !== 64 || amountWord.length !== 64 || !/^0{24}[0-9a-f]{40}$/i.test(beneficiaryWord)) return undefined;
  const claimOffset = Number(BigInt(`0x${claimOffsetWord}`));
  if (!Number.isSafeInteger(claimOffset) || claimOffset < 160) return undefined;
  const claimLengthOffset = tupleStart + claimOffset * 2;
  const claimLengthWord = args.slice(claimLengthOffset, claimLengthOffset + 64);
  if (claimLengthWord.length !== 64) return undefined;
  const claimLength = Number(BigInt(`0x${claimLengthWord}`));
  if (!Number.isSafeInteger(claimLength) || claimLength <= 0) return undefined;
  const claimIdentity = args.slice(claimLengthOffset + 64, claimLengthOffset + 64 + claimLength * 2);
  if (claimIdentity.length !== claimLength * 2) return undefined;
  let remaining = claimLength;
  const lengthBytes: number[] = [];
  while (remaining >= 0x80) {
    lengthBytes.push((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }
  lengthBytes.push(remaining & 0x7f);
  const lengthHex = lengthBytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return {
    beneficiary: `0x${beneficiaryWord.slice(24).toLowerCase()}`,
    amount: BigInt(`0x${amountWord}`),
    index: BigInt(`0x${indexWord}`),
    claimIdentityHash: keccak256(`0x20${lengthHex}${claimIdentity.toLowerCase()}`).toLowerCase(),
  };
}

function pinnedEvent(spec: ResolvedSpec, logicalId: string, eventName: string): AbiEvent {
  const abi = spec.contracts[logicalId]?.artifact.abi as Abi | undefined;
  const events = abi?.filter((item): item is AbiEvent => item.type === 'event' && item.name === eventName) ?? [];
  if (events.length !== 1) throw new ConfigError('CAPITAL_FLOW_EVENT_ABI_MISMATCH', `Pinned ${logicalId} ABI does not contain exactly one ${eventName} event`);
  return events[0]!;
}

function matchingEventLogs(
  receipt: NonNullable<Awaited<ReturnType<RpcTransport['getTransactionReceipt']>>>,
  emitter: string,
  event: AbiEvent,
  actionId: string,
): Array<Record<string, unknown>> {
  const selector = toEventSelector(event).toLowerCase();
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === emitter.toLowerCase() && log.topics[0]?.toLowerCase() === selector);
  if (logs.length !== 1) throw new ConfigError('CAPITAL_FLOW_LOG_MISMATCH', `Capital-flow action ${actionId} must emit exactly one ${event.name} event from its pinned contract`);
  try {
    const decoded = decodeEventLog({ abi: [event], data: logs[0]!.data, topics: logs[0]!.topics, strict: true });
    return [decoded.args as Record<string, unknown>];
  } catch {
    throw new ConfigError('CAPITAL_FLOW_LOG_MISMATCH', `Capital-flow action ${actionId} emitted a malformed ${event.name} event`);
  }
}

function eventValuesMatch(actual: Record<string, unknown>, expected: Record<string, string | bigint>): boolean {
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actualValue = actual[key];
    if (typeof expectedValue === 'bigint') return actualValue === expectedValue;
    return typeof actualValue === 'string' && actualValue.toLowerCase() === expectedValue.toLowerCase();
  });
}

function assertSingleTransfer(
  receipt: NonNullable<Awaited<ReturnType<RpcTransport['getTransactionReceipt']>>>,
  tokenAddress: string,
  from: string,
  to: string,
  amount: bigint,
  event: AbiEvent,
  actionId: string,
): void {
  const transfers = matchingEventLogs(receipt, tokenAddress, event, actionId);
  if (!eventValuesMatch(transfers[0]!, { from, to, value: amount })) {
    throw new ConfigError('CAPITAL_FLOW_LOG_MISMATCH', `Capital-flow action ${actionId} does not emit exactly the token transfer bound to its call and operation`);
  }
}

function assertOperationEvent(
  receipt: NonNullable<Awaited<ReturnType<RpcTransport['getTransactionReceipt']>>>,
  emitter: string,
  event: AbiEvent,
  expectedValues: Record<string, string | bigint>,
  actionId: string,
): void {
  const events = matchingEventLogs(receipt, emitter, event, actionId);
  if (!eventValuesMatch(events[0]!, expectedValues)) {
    throw new ConfigError('CAPITAL_FLOW_LOG_MISMATCH', `Capital-flow action ${actionId} lacks its exact operation event cross-linked to the executed call`);
  }
}

function assertCapitalActionLogs(
  evidence: FlowEvidence,
  inputs: Map<string, string>,
  receipts: Map<string, NonNullable<Awaited<ReturnType<RpcTransport['getTransactionReceipt']>>>>,
  manifest: DeploymentManifest,
  spec: ResolvedSpec,
): void {
  const address = (logicalId: string) => manifest.contracts.find((contract) => contract.logicalId === logicalId)?.address;
  const token = address('prf/local-token');
  const reserve = address('shortfall/shortfall-reserve-v2');
  const allocator = address('shortfall/pro-rata-allocator-v2');
  const ratificationController = address('shortfall/entitlement-ratification-controller-v1');
  if (!token || !reserve || !allocator || !ratificationController) {
    throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', 'Capital-flow transfer verification requires token, reserve, allocator and ratification-controller deployments');
  }

  const admissionValues = calldataBytes(inputs.get('statement-admission') ?? '', 3);
  if (!admissionValues || admissionValues.length !== 2 + 9 * 64) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Capital-flow transfer verification requires canonical admitted entitlement public values');
  }
  const fundedAmount = BigInt(`0x${admissionValues.slice(2 + 7 * 64, 2 + 8 * 64)}`);
  const ratificationReceipt = receipts.get('ratification-and-funding');
  if (!ratificationReceipt) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', 'Ratification receipt is unavailable for event replay');
  assertOperationEvent(
    ratificationReceipt,
    ratificationController,
    pinnedEvent(spec, 'shortfall/entitlement-ratification-controller-v1', 'EntitlementRatificationFunded'),
    { operationId: evidence.operationId, receiptId: evidence.admissionReceiptId, amount: fundedAmount },
    'ratification-and-funding',
  );
  assertSingleTransfer(ratificationReceipt, token, reserve, allocator, fundedAmount, pinnedEvent(spec, 'prf/local-token', 'Transfer'), 'ratification-and-funding');

  const withdrawal = inputs.get('entitlement-withdrawal') ?? '';
  const identity = withdrawalIdentity(withdrawal);
  const withdrawalReceipt = receipts.get('entitlement-withdrawal');
  if (!identity || !withdrawalReceipt) throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Withdrawal receipt cannot be bound to its decoded entitlement call');
  assertOperationEvent(
    withdrawalReceipt,
    allocator,
    pinnedEvent(spec, 'shortfall/pro-rata-allocator-v2', 'EntitlementWithdrawn'),
    { operationId: evidence.operationId, entitlementIndex: identity.index, beneficiary: identity.beneficiary, amount: identity.amount },
    'entitlement-withdrawal',
  );
  assertSingleTransfer(withdrawalReceipt, token, allocator, identity.beneficiary, identity.amount, pinnedEvent(spec, 'prf/local-token', 'Transfer'), 'entitlement-withdrawal');
}

function assertOperationBindings(evidence: FlowEvidence, inputs: Map<string, string>, manifest: DeploymentManifest, expectedC0Root: string, executor: CapitalFlowExpectations['operationExecutor']): void {
  const admission = inputs.get('statement-admission') ?? '';
  const admissionValues = calldataBytes(admission, 3);
  const assurance = inputs.get('assurance-preparation') ?? '';
  const operationPreparation = inputs.get('operation-preparation') ?? '';
  if (calldataWord(admission, 0) !== evidence.verifierId.toLowerCase() ||
      calldataWord(admission, 1) !== evidence.statementRoot.toLowerCase() ||
      !admissionValues || `0x${createHash('sha256').update(Buffer.from(admissionValues.slice(2), 'hex')).digest('hex')}` !== evidence.publicValuesSha256.toLowerCase() ||
      calldataWord(assurance, 0) !== evidence.operationId.toLowerCase() ||
      calldataWord(assurance, 1) !== evidence.admissionReceiptId.toLowerCase() || calldataBytes(assurance, 2) !== admissionValues) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Admission and assurance calls do not bind the declared verifier, statement, operation, receipt and identical public values');
  }
  const sourceValuesSchema = keccak256(toBytes('prf/source-bound-entitlement-public-values.v1')).toLowerCase();
  const publicValueWords = Array.from({ length: 9 }, (_, index) => `0x${admissionValues.slice(2 + index * 64, 2 + (index + 1) * 64).toLowerCase()}`);
  if (admissionValues.length !== 2 + 9 * 64 || publicValueWords[0] !== sourceValuesSchema ||
      publicValueWords[1] !== evidence.preparedOperationRoot.toLowerCase() ||
      publicValueWords[2] !== evidence.reserveStateCommitment.toLowerCase() ||
      publicValueWords[3] !== evidence.statementRoot.toLowerCase()) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Admitted public values do not encode the declared entitlement schema, prepared operation root and reserve commitment');
  }
  if (calldataWord(operationPreparation, 0) !== evidence.operationId.toLowerCase() ||
      calldataWord(operationPreparation, 2) !== `0x${evidence.chainId.toString(16).padStart(64, '0')}` ||
      calldataWord(operationPreparation, 6) !== evidence.configurationRoot.toLowerCase() ||
      calldataWord(operationPreparation, 7) !== `0x${evidence.configurationEpoch.toString(16).padStart(64, '0')}` ||
      calldataWord(operationPreparation, 8) !== evidence.verifierId.toLowerCase()) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Prepared operation is not bound to the evidence operation ID, chain, applied C1, epoch and source verifier');
  }
  const addressWord = (address: string | undefined) => address ? `0x${address.slice(2).toLowerCase().padStart(64, '0')}` : undefined;
  const preparedTopology = [
    { index: 3, logicalId: 'shortfall/shortfall-reserve-v2' },
    { index: 4, logicalId: 'prf/local-token' },
    { index: 5, logicalId: 'shortfall/pro-rata-allocator-v2' },
  ];
  for (const { index, logicalId } of preparedTopology) {
    const deployedAddress = manifest.contracts.find((contract) => contract.logicalId === logicalId)?.address;
    if (!deployedAddress || calldataWord(operationPreparation, index) !== addressWord(deployedAddress)) {
      throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', `Prepared operation does not bind the deployed ${logicalId} address`);
    }
  }
  const expectedOperationCalls = ['operation-preparation', 'entitlement-withdrawal', 'repeated-withdrawal'];
  for (const id of expectedOperationCalls) {
    if (calldataWord(inputs.get(id) ?? '', 0) !== evidence.operationId.toLowerCase()) {
      throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', `Capital-flow action ${id} does not use the admitted operation identity`);
    }
  }
  const ratification = inputs.get('ratification-and-funding') ?? '';
  const expectedResidualRecipient = calldataWord(operationPreparation, 18).slice(-40);
  const activation = inputs.get('entitlement-activation') ?? '';
  const representationWord = `0x${executor.representation.slice(2).toLowerCase().padStart(64, '0')}`;
  if (calldataWord(ratification, 0) !== evidence.reserveStateCommitment.toLowerCase() ||
      calldataWord(ratification, 1).slice(-40) !== expectedResidualRecipient ||
      calldataWord(activation, 0) !== representationWord) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Operation-scoped funding and activation calls do not match the prepared reserve commitment, residual recipient and approved representation');
  }
  if ((inputs.get('repeated-ratification') ?? '').toLowerCase() !== ratification.toLowerCase()) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Repeated ratification must replay the exact operation-scoped funding call');
  }
  const wrongOperation = inputs.get('wrong-operation') ?? '';
  if (calldataWord(wrongOperation, 0) === evidence.operationId.toLowerCase() ||
      calldataWord(wrongOperation, 1) !== evidence.admissionReceiptId.toLowerCase() || calldataBytes(wrongOperation, 2) !== admissionValues) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Wrong-operation case does not preserve the admitted receipt while substituting the operation identity');
  }
  if ((inputs.get('repeated-admission') ?? '').toLowerCase() !== admission.toLowerCase()) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Repeated admission must replay the identical call and therefore the same receipt identity');
  }
  const wrongProof = inputs.get('wrong-proof') ?? '';
  if (calldataWord(wrongProof, 0) !== calldataWord(admission, 0) || calldataWord(wrongProof, 1) !== calldataWord(admission, 1) ||
      calldataBytes(wrongProof, 2) === calldataBytes(admission, 2) || calldataBytes(wrongProof, 3) !== admissionValues) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Wrong-proof case must change only the proof while retaining verifier, statement and public values');
  }
  const verifierSubstitution = inputs.get('verifier-substitution') ?? '';
  if (calldataWord(verifierSubstitution, 0) === calldataWord(admission, 0) || calldataWord(verifierSubstitution, 1) !== calldataWord(admission, 1) ||
      calldataBytes(verifierSubstitution, 2) !== calldataBytes(admission, 2) || calldataBytes(verifierSubstitution, 3) !== admissionValues) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Verifier-substitution case must change only verifier identity while retaining statement, proof and public values');
  }
  const staleTuple = evidence.staleC0Operation.map((word) => word.toLowerCase());
  const staleRoot = keccak256(`0x${keccak256(toBytes('prf.prepared-operation.v2')).slice(2)}${staleTuple.map((word) => word.slice(2)).join('')}`).toLowerCase();
  const activeTuple = Array.from({ length: 19 }, (_, index) => calldataWord(operationPreparation, index));
  const staleAdmission = inputs.get('stale-c0-admission') ?? '';
  const staleAssurance = inputs.get('stale-c0-assurance') ?? '';
  const staleValues = calldataBytes(staleAdmission, 3);
  if (!isHash(expectedC0Root) || expectedC0Root.toLowerCase() === evidence.configurationRoot.toLowerCase() ||
      staleTuple.some((word, index) => index !== 6 && index !== 7 && word !== activeTuple[index]) ||
      staleTuple[0] !== evidence.operationId.toLowerCase() ||
      staleTuple[2] !== `0x${evidence.chainId.toString(16).padStart(64, '0')}` ||
      staleTuple[3] !== calldataWord(operationPreparation, 3) || staleTuple[4] !== calldataWord(operationPreparation, 4) || staleTuple[5] !== calldataWord(operationPreparation, 5) ||
      staleTuple[6] !== expectedC0Root.toLowerCase() || staleTuple[7] !== `0x${'0'.repeat(64)}` || staleTuple[8] !== evidence.verifierId.toLowerCase() ||
      staleRoot !== evidence.staleC0OperationRoot.toLowerCase() ||
      calldataWord(staleAdmission, 0) !== evidence.verifierId.toLowerCase() || calldataWord(staleAdmission, 1) !== evidence.statementRoot.toLowerCase() ||
      !staleValues || staleValues.length !== admissionValues.length ||
      staleValues.slice(2, 2 + 64) !== admissionValues.slice(2, 2 + 64) ||
      staleValues.slice(2 + 64, 2 + 128) !== evidence.staleC0OperationRoot.toLowerCase().slice(2) ||
      staleValues.slice(2 + 128) !== admissionValues.slice(2 + 128) ||
      calldataWord(staleAssurance, 0) !== evidence.operationId.toLowerCase() ||
      calldataWord(staleAssurance, 1) !== evidence.staleC0AdmissionReceiptId.toLowerCase() ||
      calldataBytes(staleAssurance, 2) !== staleValues) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Stale-C0 proof must bind a recomputed C0 operation root, be admitted under C1, then fail assurance against the current operation');
  }
  const wrongInstance = inputs.get('wrong-instance') ?? '';
  if (calldataWord(wrongInstance, 0) !== evidence.operationId.toLowerCase() ||
      calldataWord(wrongInstance, 2) === `0x${evidence.chainId.toString(16).padStart(64, '0')}` ||
      calldataWord(wrongInstance, 6) !== evidence.configurationRoot.toLowerCase() ||
      calldataWord(wrongInstance, 7) !== `0x${evidence.configurationEpoch.toString(16).padStart(64, '0')}`) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Wrong-instance case must preserve operation and applied configuration while substituting the chain identity');
  }
  const unauthorized = inputs.get('unauthorized-configuration-route') ?? '';
  if (calldataWord(unauthorized, 0) === `0x${'0'.repeat(64)}` ||
      calldataWord(unauthorized, 1) === `0x${'0'.repeat(64)}` ||
      calldataWord(unauthorized, 2) === `0x${'0'.repeat(64)}` ||
      calldataWord(unauthorized, 3) !== `0x${(evidence.configurationEpoch + 1).toString(16).padStart(64, '0')}` ||
      calldataWord(unauthorized, 4) !== `0x${'0'.repeat(64)}` ||
      calldataWord(unauthorized, 5) !== evidence.chainInstanceGenesisRoot.toLowerCase() ||
      calldataBytes(unauthorized, 6) !== '0x') {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Unauthorized-route case must be a well-formed next-epoch direct-target request with nonzero roots and no target proof');
  }
  const withdrawal = inputs.get('entitlement-withdrawal') ?? '';
  const repeatedWithdrawal = inputs.get('repeated-withdrawal') ?? '';
  const identity = withdrawalIdentity(withdrawal);
  if (!identity || withdrawal.toLowerCase() !== repeatedWithdrawal.toLowerCase()) {
    throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Withdrawal replay must preserve one decodable beneficiary and claim identity');
  }
  const stateArgumentCounts: Record<string, number> = {
    'prepared-operation-root': 1, 'prepared-operation-state': 1, 'admission-receipt': 1,
    'assurance-state': 1, 'reserve-state': 1, liability: 1, 'token-balance': 1,
    'consumed-assurance': 1, 'operation-state': 1, 'claim-state': 1,
    'consumed-claim': 2, 'configuration-state': 0, 'configuration-epoch': 0,
    'authority-state': 0, 'decision-authorization': 1, 'decision-proof-mode': 1,
  };
  for (const assertion of evidence.stateAssertions) {
    const expectedLength = 10 + (stateArgumentCounts[assertion.domain] ?? -100) * 64;
    if (assertion.callData.length !== expectedLength) {
      throw new ConfigError('CAPITAL_FLOW_STATE_CALL_MISMATCH', `State read ${assertion.actionId}/${assertion.domain} has a noncanonical argument count`);
    }
    const firstArgument = calldataWord(assertion.callData, 0);
    const expectedArgument = assertion.domain === 'admission-receipt'
      ? (assertion.actionId === 'stale-c0-admission' ? evidence.staleC0AdmissionReceiptId : evidence.admissionReceiptId).toLowerCase()
      : assertion.domain === 'consumed-assurance'
        ? evidence.admissionReceiptId.toLowerCase()
      : assertion.domain === 'reserve-state'
        ? evidence.preparedOperationRoot.toLowerCase()
        : assertion.domain === 'decision-authorization' || assertion.domain === 'decision-proof-mode'
          ? calldataWord(unauthorized, 0)
        : ['prepared-operation-root', 'prepared-operation-state', 'assurance-state', 'liability', 'operation-state', 'claim-state', 'consumed-claim'].includes(assertion.domain)
          ? evidence.operationId.toLowerCase()
          : undefined;
    if (expectedArgument !== undefined && firstArgument !== expectedArgument) {
      throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', `State read ${assertion.actionId}/${assertion.domain} is scoped to a different operation or receipt`);
    }
    if (assertion.domain === 'token-balance' && calldataWord(assertion.callData, 0).slice(-40) !== identity.beneficiary.slice(2)) {
      throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Token-balance read is not scoped to the withdrawal beneficiary');
    }
    if (assertion.domain === 'consumed-claim' && calldataWord(assertion.callData, 1) !== identity.claimIdentityHash) {
      throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Consumed-claim read is not scoped to the claim identity in the withdrawal');
    }
    if (assertion.actionId === 'operation-preparation' && assertion.domain === 'prepared-operation-root' && assertion.expectedAfter.toLowerCase() !== evidence.preparedOperationRoot.toLowerCase()) {
      throw new ConfigError('CAPITAL_FLOW_OPERATION_BINDING_MISMATCH', 'Prepared-operation root readback differs from the root carried by the admitted proof');
    }
  }
}

/** Replays action transactions and state-domain readbacks at isolated before/after blocks. */
export async function replayCapitalFlowEvidence(value: unknown, transport: RpcTransport, expectedChainInstanceGenesisRoot: string, expectedConfigurationRoot: string, expectedConfigurationEpoch: number, expectedInitialConfigurationRoot: string, manifest: DeploymentManifest, spec: ResolvedSpec, approvedExpectations: unknown, expectedManifestRoot: string): Promise<{ evidenceRoot: string; replayedTransactions: number; replayedStateAssertions: number }> {
  const evidence = parseEvidence(value);
  if (!isHash(expectedChainInstanceGenesisRoot) || evidence.chainInstanceGenesisRoot.toLowerCase() !== expectedChainInstanceGenesisRoot.toLowerCase()) {
    throw new ConfigError('CAPITAL_FLOW_INSTANCE_MISMATCH', 'Capital-flow evidence is not bound to the sealed genesis in the verified deployment manifest');
  }
  if (!isHash(expectedConfigurationRoot) || evidence.configurationRoot.toLowerCase() !== expectedConfigurationRoot.toLowerCase() ||
      evidence.configurationEpoch !== expectedConfigurationEpoch) {
    throw new ConfigError('CAPITAL_FLOW_CONFIGURATION_MISMATCH', 'Capital-flow evidence is not bound to the applied successor configuration root and epoch');
  }
  const checkedExpectations = assertCapitalFlowExpectations(approvedExpectations, evidence, expectedManifestRoot, expectedChainInstanceGenesisRoot, expectedConfigurationRoot, expectedConfigurationEpoch, manifest);
  const expectations = checkedExpectations.value;
  const expectationsDigest = checkedExpectations.digest;
  assertActionCalls(evidence, manifest, spec, expectations.operationExecutor);
  const chainId = await transport.getChainId();
  if (chainId !== evidence.chainId) throw new ConfigError('CAPITAL_FLOW_CHAIN_MISMATCH', `Capital-flow evidence is for chain ${evidence.chainId}, RPC reports ${chainId}`);
  const observed = new Map<string, { blockNumber: bigint; transactionHash: `0x${string}` }>();
  const observedReceipts = new Map<string, NonNullable<Awaited<ReturnType<RpcTransport['getTransactionReceipt']>>>>();
  const transactionInputs = new Map<string, string>();
  for (const step of [...evidence.positiveTransactions, ...evidence.negativeTransactions]) {
      const expectedStatus = CAPITAL_FLOW_EXPECTED_STATUSES[step.id];
      const hash = step.transactionHash as `0x${string}`;
      const [transaction, receipt] = await Promise.all([transport.getTransaction(hash), transport.getTransactionReceipt(hash)]);
      if (!transaction || !receipt || transaction.hash.toLowerCase() !== hash.toLowerCase() || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.status !== expectedStatus || receipt.blockNumber === null ||
          transaction.to?.toLowerCase() !== step.to.toLowerCase() || transaction.input.slice(0, 10).toLowerCase() !== step.selector.toLowerCase() ||
          transaction.blockNumber !== receipt.blockNumber || transaction.blockHash !== receipt.blockHash) {
        throw new ConfigError('CAPITAL_FLOW_TRANSACTION_MISMATCH', `Capital-flow transaction ${step.id} does not match its RPC transaction and receipt evidence`);
      }
      assertCanonicalActionInput(step, transaction.input, spec);
      if (CAPITAL_FLOW_ACTION_CALLS[step.id]?.logicalId === 'local/operation-scoped-entitlement-operator-v1') {
        const executor = expectations.operationExecutor;
        if (transaction.from.toLowerCase() !== executor.operator.toLowerCase()) {
          throw new ConfigError('CAPITAL_FLOW_CALL_MISMATCH', `Capital-flow action ${step.id} was not submitted by the approved operation executor principal`);
        }
        const code = await transport.getCode(executor.address as `0x${string}`, receipt.blockNumber);
        if (!code || code === '0x' || keccak256(code).toLowerCase() !== executor.runtimeCodeKeccak256.toLowerCase()) {
          throw new ConfigError('CAPITAL_FLOW_RUNTIME_IDENTITY_MISMATCH', 'Operation executor runtime code differs from the approved constructor-specific code identity');
        }
        const getter = async (address: string, abi: Abi, name: string) => {
          const fn = abi.filter((item): item is AbiFunction => item.type === 'function' && item.name === name);
          if (fn.length !== 1) throw new ConfigError('CAPITAL_FLOW_RUNTIME_IDENTITY_MISMATCH', `Pinned ABI does not contain exactly one ${name} getter`);
          return transport.call({ to: address as `0x${string}`, data: encodeFunctionData({ abi: [fn[0]!], functionName: name } as never) }, receipt.blockNumber);
        };
        const controllerAbi = entitlementRatificationControllerAbi(spec);
        const [executorOperator, executorOperation, executorController, boundCaller, boundFlag] = await Promise.all([
          getter(executor.address, LOCAL_ENTITLEMENT_OPERATOR_ABI, 'operator'),
          getter(executor.address, LOCAL_ENTITLEMENT_OPERATOR_ABI, 'operationId'),
          getter(executor.address, LOCAL_ENTITLEMENT_OPERATOR_ABI, 'controller'),
          getter(executor.controller, controllerAbi, 'executionCaller'),
          getter(executor.controller, controllerAbi, 'executionCallerBound'),
        ]);
        const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
        if (executorOperator.toLowerCase() !== addressWord(executor.operator) ||
            executorOperation.toLowerCase() !== evidence.operationId.toLowerCase() ||
            executorController.toLowerCase() !== addressWord(executor.controller) ||
            boundCaller.toLowerCase() !== addressWord(executor.address) ||
            BigInt(boundFlag) !== 1n) {
          throw new ConfigError('CAPITAL_FLOW_RUNTIME_IDENTITY_MISMATCH', 'Operation executor immutable bindings or ratification-controller caller binding differ from the approved operation');
        }
        if (step.id === 'entitlement-activation') {
          const representationCode = await transport.getCode(executor.representation as `0x${string}`, receipt.blockNumber);
          if (!representationCode || representationCode === '0x' || keccak256(representationCode).toLowerCase() !== executor.representationRuntimeCodeKeccak256.toLowerCase()) {
            throw new ConfigError('CAPITAL_FLOW_RUNTIME_IDENTITY_MISMATCH', 'Entitlement representation runtime differs from the approved artifact identity');
          }
        }
      }
      const block = await transport.getBlock(receipt.blockNumber);
      if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new ConfigError('CAPITAL_FLOW_BLOCK_MISMATCH', `Capital-flow transaction ${step.id} is not anchored to the reported canonical block`);
      if (receipt.blockNumber === 0n) throw new ConfigError('CAPITAL_FLOW_BLOCK_MISMATCH', `Capital-flow transaction ${step.id} has no preceding state block`);
      const blockTransactions = await transport.getBlockTransactionHashes(receipt.blockNumber);
      if (blockTransactions.length !== 1 || blockTransactions[0]?.toLowerCase() !== hash.toLowerCase()) {
        throw new ConfigError('CAPITAL_FLOW_BLOCK_NOT_ISOLATED', `Capital-flow transaction ${step.id} must be the only transaction in its block for before/after state replay`);
      }
      observed.set(step.id, { blockNumber: receipt.blockNumber, transactionHash: hash });
      observedReceipts.set(step.id, receipt);
      transactionInputs.set(step.id, transaction.input);
  }
  const chronology = CAPITAL_FLOW_EXECUTION_ORDER.map((id) => observed.get(id)?.blockNumber);
  if (chronology.some((block, index) => block === undefined || (index > 0 && block <= chronology[index - 1]!))) {
    throw new ConfigError('CAPITAL_FLOW_ORDER_MISMATCH', 'Capital-flow transactions do not follow the required operation, proof, assurance and capital-consumption order');
  }
  for (let index = 1; index < chronology.length; index++) {
    const previous = chronology[index - 1]!;
    const current = chronology[index]!;
    if (current - previous > 65n) throw new ConfigError('CAPITAL_FLOW_ORDER_MISMATCH', 'Capital-flow evidence contains an excessive unobserved block gap');
    for (let blockNumber = previous + 1n; blockNumber < current; blockNumber++) {
      if ((await transport.getBlockTransactionHashes(blockNumber)).length !== 0) {
        throw new ConfigError('CAPITAL_FLOW_BLOCK_NOT_ISOLATED', `Unreported transaction exists between capital-flow actions at block ${blockNumber}`);
      }
    }
  }
  assertOperationBindings(evidence, transactionInputs, manifest, expectedInitialConfigurationRoot, expectations.operationExecutor);
  assertCapitalActionLogs(evidence, transactionInputs, observedReceipts, manifest, spec);
  for (const assertion of evidence.stateAssertions) {
    const action = observed.get(assertion.actionId);
    if (!action) throw new ConfigError('CAPITAL_FLOW_EVIDENCE_INVALID', `Missing observed transaction for state assertion ${assertion.actionId}/${assertion.domain}`);
    const before = await transport.call({ to: assertion.contract as `0x${string}`, data: assertion.callData as `0x${string}` }, action.blockNumber - 1n);
    const after = await transport.call({ to: assertion.contract as `0x${string}`, data: assertion.callData as `0x${string}` }, action.blockNumber);
    const expectedBefore = assertion.expectedBefore.toLowerCase();
    const expectedAfter = assertion.expectedAfter.toLowerCase();
    const mustChange = (CAPITAL_FLOW_POSITIVE_STEPS as readonly string[]).includes(assertion.actionId) ||
      (assertion.actionId === 'stale-c0-admission' && assertion.domain === 'admission-receipt');
    const stateMustChange = mustChange && assertion.domain !== 'configuration-state' && assertion.domain !== 'configuration-epoch';
    const expectedConfigurationValue = assertion.domain === 'configuration-state'
      ? evidence.configurationRoot.toLowerCase()
      : assertion.domain === 'configuration-epoch'
        ? `0x${BigInt(evidence.configurationEpoch).toString(16).padStart(64, '0')}`
        : undefined;
    if (before.toLowerCase() !== expectedBefore || after.toLowerCase() !== expectedAfter ||
        (stateMustChange ? expectedBefore === expectedAfter : expectedBefore !== expectedAfter) ||
        (expectedConfigurationValue !== undefined && (expectedBefore !== expectedConfigurationValue || expectedAfter !== expectedConfigurationValue))) {
      throw new ConfigError('CAPITAL_FLOW_STATE_ASSERTION_MISMATCH', `Capital-flow state assertion ${assertion.actionId}/${assertion.domain} differs: before ${before} (expected ${expectedBefore}), after ${after} (expected ${expectedAfter})`);
    }
  }
  return {
    evidenceRoot: `0x${createHash('sha256').update(canonicalJson({ evidence, expectationsDigest }), 'utf8').digest('hex')}`,
    replayedTransactions: evidence.positiveTransactions.length + evidence.negativeTransactions.length,
    replayedStateAssertions: evidence.stateAssertions.length,
  };
}
