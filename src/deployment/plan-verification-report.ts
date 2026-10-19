import { createHash } from 'crypto';
import * as fs from 'fs';
import { canonicalJson } from '../canonical-json';
import { ConfigError } from '../errors';

export interface PlanVerificationReportInput {
  planId: string;
  executionStatus: 'complete' | 'partial';
  planExecutionRoot: string;
  manifestRoot: string;
  resolvedSpecSha256: string;
  replayedPrfAssertions: number;
  liveVerificationRoot: string;
  capitalFlowEvidenceRoot: string | null;
  replayedCapitalFlowTransactions: number;
  replayedCapitalFlowStateAssertions: number;
}

export const PLAN_VERIFICATION_TRUST_ASSUMPTIONS = [
  'The caller supplies the trusted-context root independently and verifies that its approval keys and source pins are controlled by the intended local authority.',
  'The selected RPC endpoint reports authentic chain identity, historical block hashes, transaction receipts, and contract state for the local Anvil instance.',
  'The pinned PRF checkout, deployment source bundle, compiler artifacts, and fixture bundle are the reviewed inputs selected by the qualification authority.',
  'The human approval decision and custody of the configured approval keys are trusted; cryptographic verification proves key use and scope, not the legitimacy of that decision.',
  'Capital-flow getter targets and arguments are checked against the pinned topology and transaction bindings; producer-supplied expected historical values still require qualification review against the approved operation.',
  'Proof-system soundness and external toolchain supply-chain integrity remain assumptions outside this deployment-evidence verifier.',
] as const;

export interface PlanVerificationReportV3 extends PlanVerificationReportInput {
  schema: 'protocol-deployment-independent-verification/v3';
  status: 'verified';
  scope: 'local-anvil-only';
  qualification: 'verification-evidence-only-not-approval';
  trustAssumptions: readonly string[];
  reportRoot: string;
}

function validInput(input: PlanVerificationReportInput): boolean {
  return typeof input.planId === 'string' && input.planId.length > 0 &&
      (input.executionStatus === 'complete' || input.executionStatus === 'partial') &&
      /^0x[0-9a-f]{64}$/.test(input.planExecutionRoot) &&
      /^0x[0-9a-f]{64}$/.test(input.manifestRoot) &&
      /^[0-9a-f]{64}$/.test(input.resolvedSpecSha256) &&
      Number.isSafeInteger(input.replayedPrfAssertions) && input.replayedPrfAssertions >= 0 &&
      /^0x[0-9a-f]{64}$/.test(input.liveVerificationRoot) &&
      (input.capitalFlowEvidenceRoot === null || /^0x[0-9a-f]{64}$/.test(input.capitalFlowEvidenceRoot)) &&
      Number.isSafeInteger(input.replayedCapitalFlowTransactions) && input.replayedCapitalFlowTransactions >= 0 &&
      Number.isSafeInteger(input.replayedCapitalFlowStateAssertions) && input.replayedCapitalFlowStateAssertions >= 0 &&
      ((input.capitalFlowEvidenceRoot === null) === (input.replayedCapitalFlowTransactions === 0)) &&
      ((input.capitalFlowEvidenceRoot === null) === (input.replayedCapitalFlowStateAssertions === 0));
}

export function buildPlanVerificationReport(input: PlanVerificationReportInput): PlanVerificationReportV3 {
  if (!validInput(input)) {
    throw new ConfigError('CONFIG_SCHEMA', 'Independent verification report input is incomplete or malformed');
  }
  const body = {
    schema: 'protocol-deployment-independent-verification/v3' as const,
    status: 'verified' as const,
    scope: 'local-anvil-only' as const,
    qualification: 'verification-evidence-only-not-approval' as const,
    trustAssumptions: [...PLAN_VERIFICATION_TRUST_ASSUMPTIONS],
    ...input,
  };
  return {
    ...body,
    reportRoot: createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex'),
  };
}

export function verifyPlanVerificationReport(value: unknown): PlanVerificationReportV3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('PLAN_VERIFICATION_REPORT_INVALID', 'Independent verification report must be a JSON object');
  }
  const report = value as Partial<PlanVerificationReportV3>;
  const { reportRoot, ...body } = report;
  const input: PlanVerificationReportInput = {
    planId: report.planId ?? '',
    executionStatus: report.executionStatus ?? 'partial',
    planExecutionRoot: report.planExecutionRoot ?? '',
    manifestRoot: report.manifestRoot ?? '',
    resolvedSpecSha256: report.resolvedSpecSha256 ?? '',
    replayedPrfAssertions: report.replayedPrfAssertions ?? -1,
    liveVerificationRoot: report.liveVerificationRoot ?? '',
    capitalFlowEvidenceRoot: report.capitalFlowEvidenceRoot ?? null,
    replayedCapitalFlowTransactions: report.replayedCapitalFlowTransactions ?? -1,
    replayedCapitalFlowStateAssertions: report.replayedCapitalFlowStateAssertions ?? -1,
  };
  const expectedKeys = ['planId', 'executionStatus', 'planExecutionRoot', 'manifestRoot', 'resolvedSpecSha256',
    'replayedPrfAssertions', 'liveVerificationRoot', 'capitalFlowEvidenceRoot', 'replayedCapitalFlowTransactions', 'replayedCapitalFlowStateAssertions', 'schema', 'status', 'scope',
    'qualification', 'trustAssumptions', 'reportRoot'].sort();
  if (canonicalJson(Object.keys(report).sort()) !== canonicalJson(expectedKeys) ||
      report.schema !== 'protocol-deployment-independent-verification/v3' || report.status !== 'verified' ||
      report.scope !== 'local-anvil-only' || report.qualification !== 'verification-evidence-only-not-approval' ||
      !validInput(input) || !Array.isArray(report.trustAssumptions) ||
      canonicalJson(report.trustAssumptions) !== canonicalJson(PLAN_VERIFICATION_TRUST_ASSUMPTIONS) ||
      typeof reportRoot !== 'string' || !/^[0-9a-f]{64}$/.test(reportRoot) ||
      createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex') !== reportRoot) {
    throw new ConfigError('PLAN_VERIFICATION_REPORT_INVALID', 'Independent verification report fields, trust assumptions, or digest are invalid');
  }
  return report as PlanVerificationReportV3;
}

export function persistPlanVerificationReport(report: PlanVerificationReportV3, file: string): void {
  const verified = verifyPlanVerificationReport(report);
  const content = `${JSON.stringify(verified, null, 2)}\n`;
  try { fs.writeFileSync(file, content, { flag: 'wx' }); }
  catch (error) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
      throw new ConfigError('PLAN_VERIFICATION_REPORT_CONFLICT', `Refusing to overwrite incompatible verification report '${file}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
