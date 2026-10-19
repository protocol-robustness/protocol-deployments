import { describe, expect, it } from 'vitest';
import { encodeFunctionData, keccak256, toBytes, toEventSelector, toFunctionSelector } from 'viem';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { assertCapitalFlowExecutionComplete, replayCapitalFlowEvidence, CAPITAL_FLOW_ACTION_CALLS, CAPITAL_FLOW_ASSERTION_DOMAINS, CAPITAL_FLOW_EXECUTION_ORDER, CAPITAL_FLOW_FULL_EXECUTION_ORDER, CAPITAL_FLOW_EXPECTED_STATUSES, CAPITAL_FLOW_NEGATIVE_CASES, CAPITAL_FLOW_POSITIVE_STEPS, CAPITAL_FLOW_SETUP_STEPS, CAPITAL_FLOW_STATE_CALLS, LOCAL_ENTITLEMENT_OPERATOR_ABI } from '../src/deployment/capital-flow-replay';
import { buildPlanVerificationReport } from '../src/deployment/plan-verification-report';
import { ConfigError } from '../src/errors';
import { FakeTransport } from './fake-chain';

const to = '0x1234567890123456789012345678901234567890';
const blockHash = `0x${'f'.repeat(64)}`;
const operationId = `0x${'1'.repeat(64)}`;
const admissionReceiptId = `0x${'2'.repeat(64)}`;
const preparedOperationRoot = `0x${'3'.repeat(64)}`;
const reserveStateCommitment = `0x${'4'.repeat(64)}`;
const statementRoot = `0x${'5'.repeat(64)}`;
const verifierId = `0x${'6'.repeat(64)}`;
const operationExecutorAddress = `0x${'2'.repeat(40)}`;
const operationExecutorPrincipal = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const representationAddress = `0x${'3'.repeat(40)}`;
const beneficiaryAddress = `0x${'4'.repeat(40)}`;
const fakeRuntimeCode = `0x${'60'.repeat(64)}` as const;
const fakeRuntimeCodeHash = keccak256(fakeRuntimeCode);
const operationExecutorCreationInput = '0x60006000';
const representationCreationInput = '0x60016001';
const creationInputSha256 = (input: string) => createHash('sha256').update(Buffer.from(input.slice(2), 'hex')).digest('hex');
const claimIdentity = 'claim-1';
const claimIdentityHex = Buffer.from(claimIdentity, 'utf8').toString('hex');
const claimIdentityHash = keccak256(`0x2007${claimIdentityHex}`);
const unauthorizedDecisionRoot = `0x${'9'.repeat(64)}`;
const c0ConfigurationRoot = `0x${'b'.repeat(64)}`;
const configurationRoot = `0x${'a'.repeat(64)}`;
const chainInstanceGenesisRoot = `0x${'a'.repeat(64)}`;
const configurationEpoch = 1;
const publicValues = `0x${[
  keccak256(toBytes('prf/source-bound-entitlement-public-values.v1')),
  preparedOperationRoot,
  reserveStateCommitment,
  statementRoot,
  `0x${'9'.repeat(64)}`,
  `0x${'a'.repeat(64)}`,
  `0x${'0'.repeat(63)}3`,
  `0x${'0'.repeat(62)}46`,
  `0x${'b'.repeat(64)}`,
].map((value) => value.slice(2).padStart(64, '0')).join('')}`;
const proof = '0x11223344';
const wrongProof = '0x55667788';
const wrongValues = '0xdeadbeef';
const staleC0AdmissionReceiptId = `0x${'8'.repeat(64)}`;
const artifactNames: Record<string, string> = {
  'shortfall/prepared-operation-controller-v2': 'SourceBoundProRataControllerV2',
  'prf/statement-admission': 'PrfStatementAdmission',
  'shortfall/source-bound-entitlement-assurance-v1': 'SourceBoundProRataEntitlementAssuranceV1',
  'shortfall/entitlement-ratification-controller-v1': 'SourceBoundProRataEntitlementRatificationControllerV1',
  'shortfall/pro-rata-allocator-v2': 'ProductionProRataAllocatorV2',
  'prf/configuration-executor': 'SewConfigurationExecutor',
  'shortfall/shortfall-reserve-v2': 'OnchainShortfallReserveV2',
  'prf/local-token': 'LocalSnapshotToken',
  'prf/governance-authority': 'SewGovernanceAuthorityAdapter',
};
const artifactDirectory = resolve(__dirname, '../fixtures/releases/0.4.2/packages/@protocol-robustness/prf-evm-deployables/artifacts');
const abiFor = (logicalId: string) => JSON.parse(readFileSync(resolve(artifactDirectory, `${artifactNames[logicalId]}.json`), 'utf8')).abi as Array<{ type: string; name?: string; inputs?: unknown[]; outputs?: unknown[]; stateMutability?: string }>;
const functionAbi = (logicalId: string, name: string) => {
  if (logicalId === 'local/operation-scoped-entitlement-operator-v1') {
    const matches = LOCAL_ENTITLEMENT_OPERATOR_ABI.filter((item) => item.type === 'function' && item.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one local operator ${name} function`);
    return matches[0] as never;
  }
  const matches = abiFor(logicalId).filter((item) => item.type === 'function' && item.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${logicalId}.${name} function in pinned fixture ABI`);
  return matches[0] as never;
};
const eventAbi = (logicalId: string, name: string) => {
  const matches = abiFor(logicalId).filter((item) => item.type === 'event' && item.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one ${logicalId}.${name} event in pinned fixture ABI`);
  return matches[0] as never;
};
const calls = Object.fromEntries(Object.entries(CAPITAL_FLOW_ACTION_CALLS).map(([id, call]) => [id, {
  ...call,
  selector: toFunctionSelector(functionAbi(call.logicalId, call.functionName)),
}]));
const selectorFor = (id: string) => calls[id]!.selector as string;
const word = (value: string) => value.slice(2).padStart(64, '0');
function encodeCall(selector: string, values: Array<string | null>, dynamic: Record<number, string> = {}): string {
  const headSize = values.length * 32;
  let tail = '';
  const head = values.map((value, index) => {
    if (value !== null) return word(value);
    const bytes = dynamic[index]!.slice(2);
    const offset = headSize + tail.length / 2;
    const encoded = `${word(`0x${BigInt(bytes.length / 2).toString(16)}`)}${bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')}`;
    tail += encoded;
    return word(`0x${offset.toString(16)}`);
  }).join('');
  return `${selector}${head}${tail}`;
}
function encodeWithdrawal(selector: string): string {
  const tuple = `${word(`0x${'0'.repeat(64)}`)}${word('0xa0')}${word(beneficiaryAddress)}${word('0x3')}${word(`0x${'7'.repeat(64)}`)}${word('0x7')}${claimIdentityHex.padEnd(64, '0')}`;
  const tupleOffset = 6 * 32;
  const tableOffset = tupleOffset + tuple.length / 2;
  const allocationOffset = tableOffset + 32;
  const head = [operationId, `0x${tupleOffset.toString(16)}`, `0x${tableOffset.toString(16)}`, '0x0', `0x${allocationOffset.toString(16)}`, '0x0'].map(word).join('');
  return `${selector}${head}${tuple}${word('0x0')}${word('0x0')}`;
}
const logicalIds = [...new Set([...Object.values(calls), ...Object.values(CAPITAL_FLOW_STATE_CALLS).map((call) => call), { logicalId: 'shortfall/entitlement-ratification-controller-v1' }].map((call) => call.logicalId))];
const pinnedLogicalIds = logicalIds.filter((logicalId) => Object.hasOwn(artifactNames, logicalId));
const manifest = { type: 'protocol-deployment-manifest/v1', deployer: operationExecutorPrincipal, contracts: pinnedLogicalIds.map((logicalId) => ({ logicalId, address: to })) } as never;
const spec = { contracts: Object.fromEntries(pinnedLogicalIds.map((logicalId) => [logicalId, { artifact: { abi: abiFor(logicalId) } }])) } as never;
const steps = [...CAPITAL_FLOW_POSITIVE_STEPS, ...CAPITAL_FLOW_NEGATIVE_CASES].map((id, i) => ({
  id,
  transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  to: ['ratification-and-funding', 'entitlement-activation', 'repeated-ratification'].includes(id) ? operationExecutorAddress : to,
  selector: calls[id]!.selector,
}));
const setupTransactions = [
  { id: 'operation-executor-deployment', transactionHash: `0x${101n.toString(16).padStart(64, '0')}`, to: null, selector: null, deployedAddress: operationExecutorAddress },
  { id: 'caller-binding', transactionHash: `0x${102n.toString(16).padStart(64, '0')}`, to, selector: toFunctionSelector(functionAbi('shortfall/entitlement-ratification-controller-v1', 'bindExecutionCaller')), deployedAddress: null },
  { id: 'reserve-seed-approval', transactionHash: `0x${103n.toString(16).padStart(64, '0')}`, to, selector: toFunctionSelector(functionAbi('prf/local-token', 'approve')), deployedAddress: null },
  { id: 'reserve-seed-deposit', transactionHash: `0x${104n.toString(16).padStart(64, '0')}`, to, selector: toFunctionSelector(functionAbi('shortfall/shortfall-reserve-v2', 'deposit')), deployedAddress: null },
  { id: 'entitlement-representation-deployment', transactionHash: `0x${105n.toString(16).padStart(64, '0')}`, to: null, selector: null, deployedAddress: representationAddress },
];
const operationArgs = Array.from({ length: 19 }, () => `0x${'0'.repeat(64)}`);
operationArgs[0] = operationId;
operationArgs[2] = `0x${BigInt(31337).toString(16).padStart(64, '0')}`;
operationArgs[3] = `0x${to.slice(2).padStart(64, '0')}`;
operationArgs[4] = `0x${to.slice(2).padStart(64, '0')}`;
operationArgs[5] = `0x${to.slice(2).padStart(64, '0')}`;
operationArgs[6] = configurationRoot;
operationArgs[7] = `0x${configurationEpoch.toString(16)}`;
operationArgs[8] = verifierId;
operationArgs[18] = `0x${to.slice(2).padStart(64, '0')}`;
const staleC0Operation = [...operationArgs];
staleC0Operation[6] = c0ConfigurationRoot;
staleC0Operation[7] = `0x${'0'.repeat(64)}`;
const staleC0OperationRoot = keccak256(`0x${keccak256(toBytes('prf.prepared-operation.v2')).slice(2)}${staleC0Operation.map((value) => value.slice(2).padStart(64, '0')).join('')}`);
const stalePublicValues = `0x${publicValues.slice(2, 2 + 64)}${staleC0OperationRoot.slice(2)}${publicValues.slice(2 + 128)}`;
const actionInputs: Record<string, string> = {
  'operation-preparation': encodeCall(selectorFor('operation-preparation'), operationArgs),
  'statement-admission': encodeCall(selectorFor('statement-admission'), [verifierId, statementRoot, null, null], { 2: proof, 3: publicValues }),
  'assurance-preparation': encodeCall(selectorFor('assurance-preparation'), [operationId, admissionReceiptId, null], { 2: publicValues }),
  'ratification-and-funding': encodeCall(selectorFor('ratification-and-funding'), [reserveStateCommitment, to]),
  'entitlement-activation': encodeCall(selectorFor('entitlement-activation'), [representationAddress]),
  'entitlement-withdrawal': encodeWithdrawal(selectorFor('entitlement-withdrawal')),
  'wrong-proof': encodeCall(selectorFor('wrong-proof'), [verifierId, statementRoot, null, null], { 2: wrongProof, 3: publicValues }),
  'verifier-substitution': encodeCall(selectorFor('verifier-substitution'), [`0x${'e'.repeat(64)}`, statementRoot, null, null], { 2: proof, 3: publicValues }),
  'wrong-instance': encodeCall(selectorFor('wrong-instance'), operationArgs.map((value, index) => index === 2 ? `0x${BigInt(1).toString(16)}` : value)),
  'stale-c0-admission': encodeCall(selectorFor('stale-c0-admission'), [verifierId, statementRoot, null, null], { 2: proof, 3: stalePublicValues }),
  'stale-c0-assurance': encodeCall(selectorFor('stale-c0-assurance'), [operationId, staleC0AdmissionReceiptId, null], { 2: stalePublicValues }),
  'wrong-operation': encodeCall(selectorFor('wrong-operation'), [`0x${'f'.repeat(64)}`, admissionReceiptId, null], { 2: publicValues }),
  'unauthorized-configuration-route': encodeCall(selectorFor('unauthorized-configuration-route'), [unauthorizedDecisionRoot, `0x${'c'.repeat(64)}`, `0x${'d'.repeat(64)}`, '0x2', '0x0', `0x${'a'.repeat(64)}`, null], { 6: '0x' }),
  'repeated-admission': '',
  'repeated-ratification': encodeCall(selectorFor('repeated-ratification'), [reserveStateCommitment, to]),
  'repeated-withdrawal': encodeWithdrawal(selectorFor('repeated-withdrawal')),
};
actionInputs['repeated-admission'] = actionInputs['statement-admission']!;
const emptyAdmissionReceipt = `0x${'0'.repeat(14 * 64)}`;
const admissionReceiptRecord = (values: string) => `0x${[
  '0x1', `0x${'1'.repeat(64)}`, chainInstanceGenesisRoot, configurationRoot,
  `0x${configurationEpoch.toString(16)}`, `0x${'2'.repeat(64)}`, verifierId, to,
  `0x${'3'.repeat(64)}`, `0x${'4'.repeat(64)}`, `0x${'5'.repeat(64)}`,
  `0x${values.slice(2, 66)}`, statementRoot,
  `0x${createHash('sha256').update(Buffer.from(values.slice(2), 'hex')).digest('hex')}`,
].map(word).join('')}`;
const currentAdmissionReceiptRecord = admissionReceiptRecord(publicValues);
const staleAdmissionReceiptRecord = admissionReceiptRecord(stalePublicValues);
const expectedStateBefore = (actionId: string, domain: string): string => {
  if (domain === 'admission-receipt') return actionId === 'repeated-admission' ? currentAdmissionReceiptRecord : emptyAdmissionReceipt;
  if (['decision-authorization', 'decision-proof-mode'].includes(domain)) return `0x${'0'.repeat(domain === 'decision-authorization' ? 9 * 64 : 64)}`;
  if (domain === 'configuration-state') return configurationRoot;
  if (domain === 'configuration-epoch') return `0x${configurationEpoch.toString(16).padStart(64, '0')}`;
  if (domain === 'prepared-operation-root' || domain === 'prepared-operation-state') return `0x${'0'.repeat(64)}`;
  if (domain === 'assurance-state' && actionId === 'wrong-operation') return '0x02';
  if (['repeated-ratification', 'repeated-withdrawal'].includes(actionId) && domain !== 'operation-state') return '0x02';
  if (domain === 'operation-state') {
    if (actionId === 'ratification-and-funding') return `0x${'0'.repeat(64)}`;
    if (['entitlement-activation', 'repeated-ratification'].includes(actionId)) return `0x${'0'.repeat(63)}2`;
    if (actionId === 'repeated-withdrawal') return `0x${'0'.repeat(63)}5`;
    if (actionId === 'wrong-operation') return `0x${'0'.repeat(64)}`;
    return `0x${'0'.repeat(63)}4`;
  }
  return '0x01';
};
const expectedStateAfter = (actionId: string, domain: string, actionIndex: number): string => {
  if (domain === 'admission-receipt') {
    if (actionId === 'statement-admission' || actionId === 'repeated-admission') return currentAdmissionReceiptRecord;
    if (actionId === 'stale-c0-admission') return staleAdmissionReceiptRecord;
    return emptyAdmissionReceipt;
  }
  if (['decision-authorization', 'decision-proof-mode'].includes(domain)) return `0x${'0'.repeat(domain === 'decision-authorization' ? 9 * 64 : 64)}`;
  if (domain === 'configuration-state') return configurationRoot;
  if (domain === 'configuration-epoch') return `0x${configurationEpoch.toString(16).padStart(64, '0')}`;
  if (domain === 'prepared-operation-root') return actionId === 'wrong-instance' ? `0x${'0'.repeat(64)}` : preparedOperationRoot;
  if (domain === 'prepared-operation-state') return actionId === 'wrong-instance' ? `0x${'0'.repeat(64)}` : `0x${'0'.repeat(63)}1`;
  if (domain === 'assurance-state' && actionId === 'wrong-operation') return '0x02';
  if (['repeated-ratification', 'repeated-withdrawal'].includes(actionId) && domain !== 'operation-state') return '0x02';
  if (domain === 'operation-state') {
    if (['ratification-and-funding', 'repeated-ratification'].includes(actionId)) return `0x${'0'.repeat(63)}2`;
    if (actionId === 'entitlement-activation') return `0x${'0'.repeat(63)}3`;
    if (actionId === 'wrong-operation') return `0x${'0'.repeat(64)}`;
    return `0x${'0'.repeat(63)}5`;
  }
  return actionIndex < CAPITAL_FLOW_POSITIVE_STEPS.length ? '0x02' : '0x01';
};
const assertions = Object.entries(CAPITAL_FLOW_ASSERTION_DOMAINS).flatMap(([actionId, domains], actionIndex) => domains.map((domain, domainIndex) => ({
  actionId,
  domain,
  logicalId: CAPITAL_FLOW_STATE_CALLS[domain]!.logicalId,
  contract: to,
  callData: encodeCall(toFunctionSelector(functionAbi(CAPITAL_FLOW_STATE_CALLS[domain]!.logicalId, CAPITAL_FLOW_STATE_CALLS[domain]!.functionName)),
    domain === 'admission-receipt' ? [actionId === 'stale-c0-admission' ? staleC0AdmissionReceiptId : admissionReceiptId]
      : domain === 'consumed-assurance' ? [admissionReceiptId]
      : ['decision-authorization', 'decision-proof-mode'].includes(domain) ? [unauthorizedDecisionRoot]
      : domain === 'reserve-state' ? [preparedOperationRoot]
      : ['prepared-operation-root', 'prepared-operation-state', 'assurance-state', 'liability', 'operation-state', 'claim-state', 'consumed-claim'].includes(domain) ? [operationId, ...(domain === 'consumed-claim' ? [claimIdentityHash] : [])]
          : domain === 'token-balance' ? [beneficiaryAddress]
            : []),
  expectedBefore: expectedStateBefore(actionId, domain),
  expectedAfter: expectedStateAfter(actionId, domain, actionIndex),
})));
const evidence = {
  schema: 'protocol-capital-flow-execution/v6',
  chainId: 31337,
  chainInstanceGenesisRoot,
  configurationRoot,
  configurationEpoch,
  operationId,
  admissionReceiptId,
  preparedOperationRoot,
  staleC0OperationRoot,
  staleC0Operation,
  staleC0AdmissionReceiptId,
  reserveStateCommitment,
  statementRoot,
  verifierId,
  publicValuesSha256: `0x${createHash('sha256').update(Buffer.from(publicValues.slice(2), 'hex')).digest('hex')}`,
  setupTransactions,
  positiveTransactions: steps.slice(0, CAPITAL_FLOW_POSITIVE_STEPS.length),
  negativeTransactions: steps.slice(CAPITAL_FLOW_POSITIVE_STEPS.length),
  stateAssertions: assertions,
};
const verifiedManifestRoot = `0x${'c'.repeat(64)}`;
const expectationPackage = (stateAssertions = evidence.stateAssertions) => ({
  schema: 'protocol-capital-flow-expectations/v3',
  manifestRoot: verifiedManifestRoot,
  chainInstanceGenesisRoot,
  configurationRoot,
  configurationEpoch,
  operationId,
  operationExecutor: {
    address: operationExecutorAddress,
    operator: operationExecutorPrincipal,
    operationId,
    controller: to,
    sourceSha256: '49b2278666afca559d8690a47b39456fa38a5282b581a825ceab7981c2007a5c',
    artifactSha256: '2bd343ba5a78e886cce8945202bb10bdadcd60bcf4f38750ffd76e8d4d0088fc',
    creationInputSha256: creationInputSha256(operationExecutorCreationInput),
    runtimeCodeKeccak256: fakeRuntimeCodeHash,
  },
  representation: {
    address: representationAddress,
    artifactSha256: '8e172f5b1530117db25efd64cdbf822903ddc0d11d8d0578232f4e7b1f0c2148',
    creationInputSha256: creationInputSha256(representationCreationInput),
    runtimeCodeKeccak256: fakeRuntimeCodeHash,
  },
  reserveSeed: { amount: '70', reserveBalanceBefore: '0', ownerBalanceBefore: '1000', allowanceBefore: '0' },
  stateAssertions,
});
const replay = (value: unknown, transport: FakeTransport, genesisRoot = evidence.chainInstanceGenesisRoot, c1Root = configurationRoot, epoch = configurationEpoch, c0Root = c0ConfigurationRoot, expectations: unknown = expectationPackage(), replaySpec: unknown = spec) =>
  replayCapitalFlowEvidence(value, transport, genesisRoot, c1Root, epoch, c0Root, manifest, replaySpec as never, expectations, verifiedManifestRoot);
const setupInputs: Record<string, string> = {
  'operation-executor-deployment': operationExecutorCreationInput,
  'caller-binding': encodeCall(toFunctionSelector(functionAbi('shortfall/entitlement-ratification-controller-v1', 'bindExecutionCaller')), [operationExecutorAddress]),
  'reserve-seed-approval': encodeCall(toFunctionSelector(functionAbi('prf/local-token', 'approve')), [to, '0x46']),
  'reserve-seed-deposit': encodeCall(toFunctionSelector(functionAbi('shortfall/shortfall-reserve-v2', 'deposit')), ['0x46']),
  'entitlement-representation-deployment': representationCreationInput,
};
const matchingTransport = (
  inputOverrides: Record<string, string> = {},
  order: readonly string[] = CAPITAL_FLOW_FULL_EXECUTION_ORDER,
  blockOffsets: Record<string, number> = {},
  interveningTransactions: Record<number, `0x${string}`[]> = {},
  receiptLogMutations: Record<string, 'missing-transfer' | 'wrong-transfer-recipient' | 'wrong-transfer-amount' | 'extra-transfer' | 'wrong-operation'> = {},
  identityOverrides: Partial<{ operator: string; operationId: string; controller: string; boundCaller: string; boundFlag: string }> = {},
  rpcOverrides: Partial<ConstructorParameters<typeof FakeTransport>[0]> = {},
  senderOverrides: Record<string, string> = {},
  transactionOverrides: Record<string, Partial<{ hash: string; from: string; to: string | null; input: string; blockNumber: bigint; blockHash: string }>> = {},
) => {
  const blockHashAt = (index: number) => `0x${(index + 100).toString(16).padStart(64, '0')}` as `0x${string}`;
  const chronologyIndex = new Map(order.map((id, index) => [id, index]));
  const allTransactionSteps = [...setupTransactions, ...steps];
  const idForHash = (hash: string) => allTransactionSteps.find((step) => step.transactionHash.toLowerCase() === hash.toLowerCase())!.id;
  const blockFor = (id: string) => 10 + chronologyIndex.get(id)! + (blockOffsets[id] ?? 0);
  const maxBlock = Math.max(...order.map(blockFor));
  const transferTopic = toEventSelector(eventAbi('prf/local-token', 'Transfer'));
  const fundedTopic = toEventSelector(eventAbi('shortfall/entitlement-ratification-controller-v1', 'EntitlementRatificationFunded'));
  const withdrawnTopic = toEventSelector(eventAbi('shortfall/pro-rata-allocator-v2', 'EntitlementWithdrawn'));
  const addressTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
  const amountData = (amount: bigint) => `0x${amount.toString(16).padStart(64, '0')}`;
  const transferLog = (from: string, target: string, amount: bigint) => ({
    address: to,
    topics: [transferTopic, addressTopic(from), addressTopic(target)],
    data: amountData(amount),
  });
  const receiptLogsFor = (id: string): unknown[] => {
    if (id === 'reserve-seed-deposit') return [transferLog(operationExecutorPrincipal, to, 70n)];
    if (id === 'ratification-and-funding') return [
      { address: to, topics: [fundedTopic, operationId, admissionReceiptId], data: amountData(70n) },
      transferLog(to, to, 70n),
    ];
    if (id === 'entitlement-withdrawal') return [
      { address: to, topics: [withdrawnTopic, operationId, `0x${'0'.repeat(64)}`, addressTopic(beneficiaryAddress)], data: `0x${amountData(3n).slice(2)}${amountData(0n).slice(2)}${amountData(0n).slice(2)}${amountData(3n).slice(2)}${amountData(1n).slice(2)}` },
      transferLog(to, beneficiaryAddress, 3n),
    ];
    return [];
  };
  const receiptLogs = (id: string): unknown[] => {
    const logs = receiptLogsFor(id) as Array<{ address: string; topics: string[]; data: string }>;
    switch (receiptLogMutations[id]) {
      case 'missing-transfer': return logs.slice(0, 1);
      case 'wrong-transfer-recipient': return [logs[0], { ...logs[1]!, topics: [...logs[1]!.topics.slice(0, 2), addressTopic('0x0000000000000000000000000000000000000001')] }];
      case 'wrong-transfer-amount': return [logs[0], { ...logs[1]!, data: amountData(2n) }];
      case 'extra-transfer': return [...logs, logs[1]];
      case 'wrong-operation': return [{ ...logs[0]!, topics: [logs[0]!.topics[0]!, `0x${'f'.repeat(64)}`, ...logs[0]!.topics.slice(2)] }, logs[1]];
      default: return logs;
    }
  };
  return new FakeTransport({
    ...rpcOverrides,
    blockHashes: {
      ...Object.fromEntries(Array.from({ length: maxBlock - 9 }, (_, index) => [(10 + index).toString(), blockHashAt(index)])),
      ...rpcOverrides.blockHashes,
    },
    code: (address, blockNumber) => {
      const number = Number(blockNumber ?? maxBlock);
      if (address.toLowerCase() === operationExecutorAddress.toLowerCase() && number < blockFor('operation-executor-deployment')) return '0x' as `0x${string}`;
      if (address.toLowerCase() === representationAddress.toLowerCase() && number < blockFor('entitlement-representation-deployment')) return '0x' as `0x${string}`;
      return fakeRuntimeCode;
    },
    receiptFor: (hash) => {
      const id = idForHash(hash);
      const blockNumber = blockFor(id);
      const createdAddress = id === 'operation-executor-deployment' ? operationExecutorAddress : id === 'entitlement-representation-deployment' ? representationAddress : null;
      const setup = setupTransactions.some((step) => step.id === id);
      return { transactionHash: hash, status: setup ? 'success' : CAPITAL_FLOW_EXPECTED_STATUSES[id], contractAddress: createdAddress, blockNumber: BigInt(blockNumber), blockHash: blockHashAt(blockNumber - 10), logs: receiptLogs(id) } as never;
    },
    transactionFor: (hash) => {
      const id = idForHash(hash);
      const blockNumber = blockFor(id);
      const setup = setupTransactions.find((step) => step.id === id);
      if (setup) return { hash, from: senderOverrides[id] ?? operationExecutorPrincipal, to: setup.to, input: inputOverrides[id] ?? setupInputs[id], blockNumber: BigInt(blockNumber), blockHash: blockHashAt(blockNumber - 10), ...transactionOverrides[id] } as never;
      const operationExecutorCall = ['ratification-and-funding', 'entitlement-activation', 'repeated-ratification'].includes(id);
      return { hash, from: operationExecutorPrincipal, to: operationExecutorCall ? operationExecutorAddress : to, input: inputOverrides[id] ?? actionInputs[id], blockNumber: BigInt(blockNumber), blockHash: blockHashAt(blockNumber - 10), ...transactionOverrides[id] } as never;
    },
    blockTransactionHashesFor: (blockNumber) => {
      const step = allTransactionSteps.find((candidate) => blockFor(candidate.id) === Number(blockNumber));
      return step ? [step.transactionHash as `0x${string}`] : interveningTransactions[Number(blockNumber)] ?? [];
    },
    callFor: (request, blockNumber) => {
      const selector = request.data?.slice(0, 10).toLowerCase();
      const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}` as `0x${string}`;
      const tokenBalanceAbi = functionAbi('prf/local-token', 'balanceOf');
      const tokenAllowanceAbi = functionAbi('prf/local-token', 'allowance');
      const tokenBalanceCall = (address: string) => encodeFunctionData({ abi: [tokenBalanceAbi], functionName: 'balanceOf', args: [address] } as never);
      const tokenAllowanceCall = encodeFunctionData({ abi: [tokenAllowanceAbi], functionName: 'allowance', args: [operationExecutorPrincipal, to] } as never);
      const block = Number(blockNumber);
      const approvalBlock = blockFor('reserve-seed-approval');
      const depositBlock = blockFor('reserve-seed-deposit');
      if (request.to?.toLowerCase() === to.toLowerCase() && request.data === tokenBalanceCall(to)) return block < depositBlock ? `0x${'0'.repeat(64)}` as `0x${string}` : `0x${'0'.repeat(62)}46` as `0x${string}`;
      if (request.to?.toLowerCase() === to.toLowerCase() && request.data === tokenBalanceCall(operationExecutorPrincipal)) return block < depositBlock ? `0x${'0'.repeat(61)}3e8` as `0x${string}` : `0x${'0'.repeat(61)}3a2` as `0x${string}`;
      if (request.to?.toLowerCase() === to.toLowerCase() && request.data === tokenAllowanceCall) {
        if (block < approvalBlock) return `0x${'0'.repeat(64)}` as `0x${string}`;
        return block < depositBlock ? `0x${'0'.repeat(62)}46` as `0x${string}` : `0x${'0'.repeat(64)}` as `0x${string}`;
      }
      const executorGetters = ['operator', 'operationId', 'controller'] as const;
      if (request.to?.toLowerCase() === operationExecutorAddress.toLowerCase()) {
        for (const name of executorGetters) {
          const getterSelector = toFunctionSelector(functionAbi('local/operation-scoped-entitlement-operator-v1', name)).toLowerCase();
          if (selector === getterSelector) {
            const result = name === 'operator' ? addressWord(identityOverrides.operator ?? operationExecutorPrincipal)
              : name === 'operationId' ? identityOverrides.operationId ?? operationId : addressWord(identityOverrides.controller ?? to);
            return result as `0x${string}`;
          }
        }
      }
      if (request.to?.toLowerCase() === to.toLowerCase()) {
        const boundCallerSelector = toFunctionSelector(functionAbi('shortfall/entitlement-ratification-controller-v1', 'executionCaller')).toLowerCase();
        const boundFlagSelector = toFunctionSelector(functionAbi('shortfall/entitlement-ratification-controller-v1', 'executionCallerBound')).toLowerCase();
        if (selector === boundCallerSelector) return block < blockFor('caller-binding') ? addressWord(`0x${'0'.repeat(40)}`) : addressWord(identityOverrides.boundCaller ?? operationExecutorAddress);
        if (selector === boundFlagSelector) return (block < blockFor('caller-binding') ? `0x${'0'.repeat(64)}` : identityOverrides.boundFlag ?? `0x${'0'.repeat(63)}1`) as `0x${string}`;
      }
      const matches = assertions.flatMap((candidate) => {
        if (candidate.callData !== request.data) return [];
        const actionBlock = blockFor(candidate.actionId);
        if (block === actionBlock - 1) return [{ assertion: candidate, before: true }];
        if (block === actionBlock) return [{ assertion: candidate, before: false }];
        return [];
      });
      const match = matches[0];
      if (!match) return '0x';
      return (match.before ? match.assertion.expectedBefore : match.assertion.expectedAfter) as `0x${string}`;
    },
    ...rpcOverrides,
  });
};

describe('capital-flow transaction replay', () => {
  it('requires a completed C1 execution receipt before flow replay', () => {
    expect(() => assertCapitalFlowExecutionComplete('complete')).not.toThrow();
    expect(() => assertCapitalFlowExecutionComplete('partial'))
      .toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXECUTION_INCOMPLETE' }));
  });

  it('requires the complete ordered positive and negative action sets', async () => {
    await expect(replay({ ...evidence, negativeTransactions: [] }, new FakeTransport()))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EVIDENCE_INVALID' } satisfies Partial<ConfigError>));
  });

  it('rejects evidence for a different RPC chain', async () => {
    await expect(replay(evidence, new FakeTransport({ chainId: 1 })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_CHAIN_MISMATCH' }));
  });

  it('rejects a transaction whose RPC identity differs from the retained step', async () => {
    const actionId = CAPITAL_FLOW_POSITIVE_STEPS[0]!;
    await expect(replay(evidence, matchingTransport({}, CAPITAL_FLOW_FULL_EXECUTION_ORDER, {}, {}, {}, {}, {}, {}, {
      [actionId]: { hash: `0x${'f'.repeat(64)}` },
    }))).rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_TRANSACTION_MISMATCH' }));
  });

  it('rejects a transaction receipt that is not in the canonical block', async () => {
    const actionId = CAPITAL_FLOW_POSITIVE_STEPS[0]!;
    const blockNumber = 10 + CAPITAL_FLOW_FULL_EXECUTION_ORDER.indexOf(actionId);
    const transport = matchingTransport();
    const getBlock = transport.getBlock.bind(transport);
    transport.getBlock = async (number) => {
      const block = await getBlock(number);
      return number === BigInt(blockNumber) ? { ...block, hash: `0x${'a'.repeat(64)}` } as never : block;
    };
    await expect(replay(evidence, transport))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_BLOCK_MISMATCH' }));
  });

  it('rejects a pinned ABI without the ratification event', async () => {
    const logicalId = 'shortfall/entitlement-ratification-controller-v1';
    const replayBaseSpec = spec as any;
    const controller = replayBaseSpec.contracts[logicalId]!;
    const brokenSpec = {
      ...replayBaseSpec,
      contracts: {
        ...replayBaseSpec.contracts,
        [logicalId]: {
          ...controller,
          artifact: {
            ...controller.artifact,
            abi: controller.artifact.abi.filter((item: any) =>
              !(item.type === 'event' && item.name === 'EntitlementRatificationFunded')),
          },
        },
      },
    };
    await expect(replay(evidence, matchingTransport(), undefined, undefined, undefined, undefined, undefined, brokenSpec))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EVENT_ABI_MISMATCH' }));
  });

  it('requires state expectations from the independently selected context and exact deployment scope', async () => {
    await expect(replay(evidence, matchingTransport(), evidence.chainInstanceGenesisRoot, configurationRoot, configurationEpoch, c0ConfigurationRoot, null))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_INVALID' }));
    await expect(replay(evidence, matchingTransport(), evidence.chainInstanceGenesisRoot, configurationRoot, configurationEpoch, c0ConfigurationRoot,
      { ...expectationPackage(), manifestRoot: `0x${'d'.repeat(64)}` }))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_MISMATCH' }));
    await expect(replay(evidence, matchingTransport(), evidence.chainInstanceGenesisRoot, configurationRoot, configurationEpoch, c0ConfigurationRoot,
      { ...expectationPackage(), configurationRoot: c0ConfigurationRoot }))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_MISMATCH' }));
  });

  it('requires independently replayable setup evidence before action replay', async () => {
    const hash = evidence.positiveTransactions[0]!.transactionHash as `0x${string}`;
    const transport = new FakeTransport({
      blockHashes: { '5': `0x${'f'.repeat(64)}` as `0x${string}` },
      receipt: { transactionHash: hash, status: 'success', blockNumber: 5n, blockHash: `0x${'e'.repeat(64)}` } as never,
      transaction: { hash, to, input: actionInputs['operation-preparation'], blockNumber: 5n, blockHash: `0x${'e'.repeat(64)}` } as never,
    });
    await expect(replay(evidence, transport))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_SETUP_MISMATCH' }));
  });

  it('rejects action evidence when required setup transactions are absent', async () => {
    const hash = evidence.positiveTransactions[0]!.transactionHash as `0x${string}`;
    const transport = new FakeTransport({
      blockHashes: { '5': blockHash as `0x${string}` },
      receipt: { transactionHash: hash, status: 'success', blockNumber: 5n, blockHash } as never,
      transaction: { hash, to, input: actionInputs['operation-preparation'], blockNumber: 5n, blockHash } as never,
    });
    await expect(replay(evidence, transport))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_SETUP_MISMATCH' }));
  });

  it('rejects incomplete setup evidence before accepting action receipts', async () => {
    const transport = new FakeTransport({
      blockHashes: { '5': blockHash as `0x${string}` },
      receipt: { transactionHash: evidence.positiveTransactions[0]!.transactionHash, status: 'success', blockNumber: 5n, blockHash } as never,
      transaction: { hash: evidence.positiveTransactions[0]!.transactionHash, to: '0x0000000000000000000000000000000000000001', input: steps[0]!.selector, blockNumber: 5n, blockHash } as never,
    });
    await expect(replay(evidence, transport))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_SETUP_MISMATCH' }));
  });

  it('rejects setup transactions from an unapproved principal', async () => {
    await expect(replay(evidence, matchingTransport({}, CAPITAL_FLOW_FULL_EXECUTION_ORDER, {}, {}, {}, {}, {}, {
      'reserve-seed-deposit': '0x0000000000000000000000000000000000000001',
    })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_SETUP_MISMATCH' }));
  });

  it('rejects reserve setup calldata that differs from the approved seed amount', async () => {
    const changedAmount = encodeCall(toFunctionSelector(functionAbi('shortfall/shortfall-reserve-v2', 'deposit')), ['0x47']);
    await expect(replay(evidence, matchingTransport({ 'reserve-seed-deposit': changedAmount })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_SETUP_MISMATCH' }));
  });

  it('rejects a producer-selected contract that differs from the fixed topology action map', async () => {
    const changed = { ...evidence, positiveTransactions: evidence.positiveTransactions.map((step, index) => index === 0 ? { ...step, to: '0x0000000000000000000000000000000000000001' } : step) };
    await expect(replay(changed, new FakeTransport()))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_CALL_MISMATCH' }));
  });

  it('rejects state readbacks outside the fixed getter contract in the pinned topology', async () => {
    const changed = { ...evidence, stateAssertions: evidence.stateAssertions.map((assertion, index) => index === 0 ? { ...assertion, contract: '0x0000000000000000000000000000000000000001' } : assertion) };
    await expect(replay(changed, new FakeTransport(), evidence.chainInstanceGenesisRoot, configurationRoot, configurationEpoch, c0ConfigurationRoot, expectationPackage(changed.stateAssertions)))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_STATE_CALL_MISMATCH' }));
  });

  it('replays all transactions and historical state domains when RPC evidence matches', async () => {
    const transport = matchingTransport();
    const result = await replay(evidence, transport);
    expect(result.replayedTransactions).toBe(CAPITAL_FLOW_SETUP_STEPS.length + CAPITAL_FLOW_POSITIVE_STEPS.length + CAPITAL_FLOW_NEGATIVE_CASES.length);
    expect(result.replayedStateAssertions).toBe(assertions.length);
    expect(result.evidenceRoot).toMatch(/^0x[0-9a-f]{64}$/);
    const report = buildPlanVerificationReport({
      planId: 'local-plan', executionStatus: 'complete', planExecutionRoot: `0x${'c'.repeat(64)}`,
      manifestRoot: `0x${'d'.repeat(64)}`, resolvedSpecSha256: 'e'.repeat(64), replayedPrfAssertions: 1,
      liveVerificationRoot: `0x${'f'.repeat(64)}`, capitalFlowEvidenceRoot: result.evidenceRoot,
      replayedCapitalFlowTransactions: result.replayedTransactions,
      replayedCapitalFlowStateAssertions: result.replayedStateAssertions,
    });
    expect(report.capitalFlowEvidenceRoot).toBe(result.evidenceRoot);
    await expect(replay({ ...evidence, operationId: `0x${'f'.repeat(64)}` }, transport))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_MISMATCH' }));
    const forged = { ...evidence, stateAssertions: evidence.stateAssertions.map((assertion) => assertion.actionId === 'ratification-and-funding' && assertion.domain === 'liability' ? { ...assertion, expectedAfter: '0xff' } : assertion) };
    await expect(replay(forged, transport))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_MISMATCH' }));
  });

  it('rejects an operation executor whose observed runtime differs from the approved constructor identity', async () => {
    const expectations = expectationPackage();
    expectations.operationExecutor.runtimeCodeKeccak256 = `0x${'f'.repeat(64)}`;
    await expect(replay(evidence, matchingTransport(), evidence.chainInstanceGenesisRoot, configurationRoot, configurationEpoch, c0ConfigurationRoot, expectations))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_RUNTIME_IDENTITY_MISMATCH' }));
  });

  it.each([
    ['operationId', { operationId: `0x${'f'.repeat(64)}` }],
    ['execution caller binding', { boundCaller: `0x${'f'.repeat(40)}` }],
    ['bound flag', { boundFlag: `0x${'0'.repeat(64)}` }],
  ])('rejects a mismatched immutable %s or controller binding', async (_label, override) => {
    await expect(replay(evidence, matchingTransport({}, CAPITAL_FLOW_FULL_EXECUTION_ORDER, {}, {}, {}, override)))
      .rejects.toThrowError(expect.objectContaining({ code: _label === 'operationId' ? 'CAPITAL_FLOW_RUNTIME_IDENTITY_MISMATCH' : 'CAPITAL_FLOW_SETUP_STATE_MISMATCH' }));
  });

  it.each([
    { action: 'ratification-and-funding', mutation: 'missing-transfer', label: 'missing reserve funding transfer' },
    { action: 'ratification-and-funding', mutation: 'wrong-transfer-amount', label: 'funding transfer with wrong amount' },
    { action: 'ratification-and-funding', mutation: 'extra-transfer', label: 'extra funding transfer' },
    { action: 'ratification-and-funding', mutation: 'wrong-operation', label: 'funding event for another operation' },
    { action: 'entitlement-withdrawal', mutation: 'missing-transfer', label: 'missing beneficiary payout' },
    { action: 'entitlement-withdrawal', mutation: 'wrong-transfer-recipient', label: 'payout to another beneficiary' },
    { action: 'entitlement-withdrawal', mutation: 'wrong-transfer-amount', label: 'payout with wrong amount' },
    { action: 'entitlement-withdrawal', mutation: 'extra-transfer', label: 'extra payout transfer' },
    { action: 'entitlement-withdrawal', mutation: 'wrong-operation', label: 'withdrawal event for another operation' },
  ] as const)('rejects $label in the retained receipt logs', async ({ action, mutation }) => {
    await expect(replay(evidence, matchingTransport({}, CAPITAL_FLOW_FULL_EXECUTION_ORDER, {}, {}, { [action]: mutation })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_LOG_MISMATCH' }));
  });

  it('rejects negative cases that change more than their declared identity binding', async () => {
    const wrongProofChangesVerifier = encodeCall(selectorFor('wrong-proof'), [`0x${'e'.repeat(64)}`, statementRoot, null, null], { 2: wrongProof, 3: publicValues });
    const verifierSubstitutionChangesProof = encodeCall(selectorFor('verifier-substitution'), [`0x${'e'.repeat(64)}`, statementRoot, null, null], { 2: wrongProof, 3: publicValues });
    const staleC0ChangesAnotherPublicValue = `0x${stalePublicValues.slice(2, -64)}${'d'.repeat(64)}`;
    const staleC0 = encodeCall(selectorFor('stale-c0-admission'), [verifierId, statementRoot, null, null], { 2: proof, 3: staleC0ChangesAnotherPublicValue });
    const wrongInstanceChangesConfiguration = encodeCall(selectorFor('wrong-instance'), operationArgs.map((value, index) => index === 2 ? `0x${BigInt(1).toString(16)}` : index === 6 ? `0x${'c'.repeat(64)}` : value));
    const malformedInputs: Array<Record<string, string>> = [
      { 'wrong-proof': wrongProofChangesVerifier },
      { 'verifier-substitution': verifierSubstitutionChangesProof },
      { 'stale-c0-admission': staleC0 },
      { 'wrong-instance': wrongInstanceChangesConfiguration },
    ];
    for (const inputOverrides of malformedInputs) {
      await expect(replay(evidence, matchingTransport(inputOverrides)))
        .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_OPERATION_BINDING_MISMATCH' }));
    }
    const alteredStaleOperation = [...evidence.staleC0Operation];
    alteredStaleOperation[9] = `0x${'d'.repeat(64)}`;
    const alteredStaleRoot = keccak256(`0x${keccak256(toBytes('prf.prepared-operation.v2')).slice(2)}${alteredStaleOperation.map((value) => value.slice(2)).join('')}`);
    const alteredStaleValues = `0x${stalePublicValues.slice(2, 2 + 64)}${alteredStaleRoot.slice(2)}${stalePublicValues.slice(2 + 128)}`;
    const alteredStaleAdmission = encodeCall(selectorFor('stale-c0-admission'), [verifierId, statementRoot, null, null], { 2: proof, 3: alteredStaleValues });
    const alteredStaleAssurance = encodeCall(selectorFor('stale-c0-assurance'), [operationId, staleC0AdmissionReceiptId, null], { 2: alteredStaleValues });
    await expect(replay({ ...evidence, staleC0Operation: alteredStaleOperation, staleC0OperationRoot: alteredStaleRoot }, matchingTransport({
      'stale-c0-admission': alteredStaleAdmission,
      'stale-c0-assurance': alteredStaleAssurance,
    }))).rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_OPERATION_BINDING_MISMATCH' }));
  });

  it('requires the unauthorized route to be well formed and its decision to be absent', async () => {
    const malformed = encodeCall(selectorFor('unauthorized-configuration-route'), [`0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`, '0x2', '0x0', evidence.chainInstanceGenesisRoot, null], { 6: '0x' });
    await expect(replay(evidence, matchingTransport({ 'unauthorized-configuration-route': malformed })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_OPERATION_BINDING_MISMATCH' }));
    const authorizedReadback = {
      ...evidence,
      stateAssertions: assertions.map((assertion) => assertion.actionId === 'unauthorized-configuration-route' && assertion.domain === 'decision-authorization'
        ? { ...assertion, expectedAfter: `0x${'0'.repeat(9 * 64 - 1)}1` }
        : assertion),
    };
    await expect(replay(authorizedReadback, matchingTransport(), evidence.chainInstanceGenesisRoot, configurationRoot, configurationEpoch, c0ConfigurationRoot, expectationPackage(authorizedReadback.stateAssertions)))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_STATE_ASSERTION_MISMATCH' }));
  });

  it('rejects transactions that occur outside the required execution chronology', async () => {
    const wrongOrder = [...CAPITAL_FLOW_FULL_EXECUTION_ORDER];
    const instanceIndex = wrongOrder.indexOf('wrong-instance');
    const preparationIndex = wrongOrder.indexOf('operation-preparation');
    [wrongOrder[instanceIndex], wrongOrder[preparationIndex]] = [wrongOrder[preparationIndex]!, wrongOrder[instanceIndex]!];
    await expect(replay(evidence, matchingTransport({}, wrongOrder)))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_ORDER_MISMATCH' }));
  });

  it('allows empty gaps but rejects unreported transactions between isolated actions', async () => {
    const offsets = Object.fromEntries(CAPITAL_FLOW_FULL_EXECUTION_ORDER.slice(2).map((id) => [id, 1]));
    await expect(replay(evidence, matchingTransport({}, CAPITAL_FLOW_FULL_EXECUTION_ORDER, offsets)))
      .resolves.toMatchObject({ replayedTransactions: steps.length + setupTransactions.length });
    await expect(replay(evidence, matchingTransport({}, CAPITAL_FLOW_FULL_EXECUTION_ORDER, offsets, {
      12: [`0x${'f'.repeat(64)}` as `0x${string}`],
    })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_BLOCK_NOT_ISOLATED' }));
  });

  it('binds balance and consumed-claim reads to the actual withdrawal identity', async () => {
    const changedBalance = {
      ...evidence,
      stateAssertions: assertions.map((assertion) => assertion.actionId === 'entitlement-withdrawal' && assertion.domain === 'token-balance'
        ? { ...assertion, callData: encodeCall(toFunctionSelector(functionAbi('prf/local-token', 'balanceOf')), ['0x0000000000000000000000000000000000000001']) }
        : assertion),
    };
    await expect(replay(changedBalance, matchingTransport()))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_MISMATCH' }));
    const changedClaim = {
      ...evidence,
      stateAssertions: assertions.map((assertion) => assertion.actionId === 'entitlement-withdrawal' && assertion.domain === 'consumed-claim'
        ? { ...assertion, callData: encodeCall(toFunctionSelector(functionAbi('shortfall/pro-rata-allocator-v2', 'consumedClaimIdentity')), [operationId, `0x${'8'.repeat(64)}`]) }
        : assertion),
    };
    await expect(replay(changedClaim, matchingTransport()))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_MISMATCH' }));
  });

  it('binds prepared-operation topology addresses to deployed contracts', async () => {
    const substitutedOperation = [...operationArgs];
    substitutedOperation[4] = `0x${'9'.repeat(40)}`;
    await expect(replay(evidence, matchingTransport({
      'operation-preparation': encodeCall(selectorFor('operation-preparation'), substitutedOperation),
    })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_OPERATION_BINDING_MISMATCH' }));
  });

  it('rejects noncanonical action calldata against the pinned ABI', async () => {
    await expect(replay(evidence, matchingTransport({
      'operation-preparation': `${actionInputs['operation-preparation']}${'0'.repeat(64)}`,
    })))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_CALL_MISMATCH' }));
  });

  it('binds the bundle to the independently verified sealed genesis', async () => {
    await expect(replay(evidence, new FakeTransport(), `0x${'b'.repeat(64)}`))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_INSTANCE_MISMATCH' }));
  });

  it('binds the capital flow to the independently verified applied C1 root and epoch', async () => {
    await expect(replay(evidence, new FakeTransport(), evidence.chainInstanceGenesisRoot, `0x${'b'.repeat(64)}`, 1))
      .rejects.toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_CONFIGURATION_MISMATCH' }));
  });
});
