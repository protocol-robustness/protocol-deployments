import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { canonicalJson } from '../src/canonical-json';
import {
  buildPlanVerificationReport,
  persistPlanVerificationReport,
  verifyPlanVerificationReport,
} from '../src/deployment/plan-verification-report';
import { ConfigError } from '../src/errors';

const input = {
  planId: 'local-plan',
  executionStatus: 'complete' as const,
  planExecutionRoot: `0x${'1'.repeat(64)}`,
  manifestRoot: `0x${'2'.repeat(64)}`,
  resolvedSpecSha256: '3'.repeat(64),
  replayedPrfAssertions: 4,
  liveVerificationRoot: `0x${'4'.repeat(64)}`,
  capitalFlowEvidenceRoot: null,
  replayedCapitalFlowTransactions: 0,
  replayedCapitalFlowStateAssertions: 0,
};

describe('independent plan verification report', () => {
  it('is deterministic and scoped as verification evidence only', () => {
    const report = buildPlanVerificationReport(input);
    expect(buildPlanVerificationReport({ ...input })).toEqual(report);
    expect(report.schema).toBe('protocol-deployment-independent-verification/v3');
    expect(report.status).toBe('verified');
    expect(report.scope).toBe('local-anvil-only');
    expect(report.qualification).toBe('verification-evidence-only-not-approval');
    expect(report.trustAssumptions.length).toBeGreaterThan(0);
    expect(report.trustAssumptions).toContain('Capital-flow getter targets and arguments are checked against the pinned topology and transaction bindings; producer-supplied expected historical values still require qualification review against the approved operation.');
    expect(verifyPlanVerificationReport(report)).toEqual(report);
    expect(report.reportRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects altered trust assumptions even if the report root is recomputed', () => {
    const report = buildPlanVerificationReport(input);
    const altered = { ...report, trustAssumptions: ['there are no trust assumptions'] };
    const { reportRoot: _root, ...body } = altered;
    const forged = {
      ...altered,
      reportRoot: createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex'),
    };
    expect(() => verifyPlanVerificationReport(forged))
      .toThrowError(expect.objectContaining({ code: 'PLAN_VERIFICATION_REPORT_INVALID' }));
  });

  it('rejects a report whose verification root was changed', () => {
    const report = buildPlanVerificationReport(input);
    expect(() => verifyPlanVerificationReport({ ...report, liveVerificationRoot: `0x${'5'.repeat(64)}` }))
      .toThrowError(expect.objectContaining({ code: 'PLAN_VERIFICATION_REPORT_INVALID' }));
  });

  it('binds every independent verification result', () => {
    expect(buildPlanVerificationReport({ ...input, liveVerificationRoot: `0x${'5'.repeat(64)}` }).reportRoot)
      .not.toBe(buildPlanVerificationReport(input).reportRoot);
    expect(buildPlanVerificationReport({ ...input, replayedPrfAssertions: 3 }).reportRoot)
      .not.toBe(buildPlanVerificationReport(input).reportRoot);
    expect(buildPlanVerificationReport({ ...input, executionStatus: 'partial' }).reportRoot)
      .not.toBe(buildPlanVerificationReport(input).reportRoot);
    expect(buildPlanVerificationReport({ ...input, capitalFlowEvidenceRoot: `0x${'6'.repeat(64)}`, replayedCapitalFlowTransactions: 14, replayedCapitalFlowStateAssertions: 44 }).reportRoot)
      .not.toBe(buildPlanVerificationReport(input).reportRoot);
  });

  it('rejects malformed resolved-spec digests and replay counts', () => {
    expect(() => buildPlanVerificationReport({ ...input, resolvedSpecSha256: 'bad' }))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_SCHEMA' } satisfies Partial<ConfigError>));
    expect(() => buildPlanVerificationReport({ ...input, replayedPrfAssertions: -1 }))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_SCHEMA' }));
    expect(() => buildPlanVerificationReport({ ...input, capitalFlowEvidenceRoot: null, replayedCapitalFlowTransactions: 1 }))
      .toThrowError(expect.objectContaining({ code: 'CONFIG_SCHEMA' }));
  });

  it('persists reports immutably and rejects conflicting content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-verification-report-'));
    const file = path.join(dir, 'report.json');
    try {
      const report = buildPlanVerificationReport(input);
      persistPlanVerificationReport(report, file);
      persistPlanVerificationReport(report, file);
      expect(() => persistPlanVerificationReport(buildPlanVerificationReport({ ...input, replayedPrfAssertions: 5 }), file))
        .toThrowError(expect.objectContaining({ code: 'PLAN_VERIFICATION_REPORT_CONFLICT' }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
