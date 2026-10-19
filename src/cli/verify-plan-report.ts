#!/usr/bin/env ts-node
import * as fs from 'fs';
import { verifyPlanVerificationReport } from '../deployment/plan-verification-report';

const index = process.argv.indexOf('--report');
const file = index >= 0 ? process.argv[index + 1] : undefined;
if (!file) throw new Error('Usage: ts-node src/cli/verify-plan-report.ts --report <verification-report.json>');

try {
  const report = verifyPlanVerificationReport(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  console.log('Independent verification report integrity verified');
  console.log(`  report root: ${report.reportRoot}`);
  console.log(`  execution status: ${report.executionStatus}`);
  console.log(`  scope: ${report.scope}`);
  console.log(`  qualification: ${report.qualification}`);
  console.log(`  capital flow: ${report.capitalFlowEvidenceRoot === null
    ? 'not supplied'
    : `verified ${report.replayedCapitalFlowTransactions} transactions and ${report.replayedCapitalFlowStateAssertions} state assertions`}`);
  console.log('  trust assumptions:');
  for (const assumption of report.trustAssumptions) console.log(`    - ${assumption}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
