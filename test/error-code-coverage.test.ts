import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');
const TEST = path.resolve(__dirname, '..', 'test');
const GUARD = path.basename(__filename);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Error codes that are deliberately not asserted in this suite, because they
 * only occur under conditions a unit test cannot set up deterministically
 * (foreign processes, multi-second timeouts, or a full CLI run). Every entry
 * must state why; anything else has to gain a test.
 */
const UNTESTED: Record<string, string> = {
  CROSS_PLAN_CONTRACT_SUBSTITUTION: 'requires a producer execution output that disagrees with its retained deployment manifest; consumer tests cover output substitution before live execution',
  CROSS_PLAN_LOCAL_ONLY_DEPENDENCY: 'requires promoting a local-only producer into a non-local consumer profile; public chain execution is intentionally not run in unit tests',
  CROSS_PLAN_MANIFEST_MISMATCH: 'requires a fully re-rooted producer evidence package whose manifest differs from the consumer-pinned manifest root',
  CROSS_PLAN_PRODUCER_PLAN_INVALID: 'requires malformed nested producer-plan data; plan schema validation is covered independently',
  CROSS_PLAN_STAGE_OUTPUT_DEPENDENCIES_MISSING: 'requires recursively nested cross-plan evidence with one omitted producer dependency; current producer plan has no nested cross-plan dependency',
  CROSS_PLAN_STAGE_OUTPUT_DIRECTORY_MISSING: 'requires invoking the resolver with a nonexistent CLI evidence directory',
  CROSS_PLAN_STAGE_OUTPUT_DUPLICATE: 'requires filesystem directory loading with two evidence packages for the same logical contract',
  CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_REQUIRED: 'resolver/deploy CLI preflight when a pinned cross-plan source omits its evidence directory',
  CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_SET: 'requires a filesystem evidence directory with extra or missing package files versus the selected plan',
  CROSS_PLAN_STAGE_OUTPUT_EXISTS_CONFLICT: 'requires writing conflicting immutable evidence to an already occupied content-addressed filename',
  CROSS_PLAN_STAGE_OUTPUT_LIVE_VERIFICATION_FAILED: 'requires a full deploy CLI run with RPC receipt/runtime evidence disagreeing with the producer output',
  CROSS_PLAN_STAGE_OUTPUT_NOT_PINNED: 'requires invoking the verifier for a logical contract not selected as a pinned cross-plan source',
  CROSS_PLAN_STAGE_OUTPUT_ROOT_MISMATCH: 'requires tampering with an evidence package without changing its consumer-pinned root',
  CROSS_PLAN_VERIFICATION_CONTRACT_MISSING: 'requires a fully re-rooted producer verification report omitting its deployed contract observation',
  CROSS_PLAN_VERIFICATION_INVALID: 'requires malformed producer verification report schema; the wrong-root and wrong-chain verification cases are covered',
  CROSS_PLAN_VERIFICATION_ROOT_MISMATCH: 'requires a consumer plan whose verification-root pin alone differs from an otherwise valid evidence package',
  DEPLOYMENT_PLAN_STAGE_OUTPUT_CYCLE: 'requires a self-referential consumer plan hash pin, which would require a cryptographic fixed point',
  DEVNET_NOT_READY: 'requires a pid file naming a live but unresponsive anvil',
  DEVNET_PORT_IN_USE: 'requires a foreign process to already own the devnet port',
  DEVNET_START_TIMEOUT: 'requires anvil to never become ready (up to 20s)',
  FEE_ESTIMATE_UNAVAILABLE: 'requires an RPC returning neither EIP-1559 fees nor a legacy gas price',
  FORK_SOURCE_UNSET: 'requires a base-fork environment and runtime fixture',
  PLAN_EXECUTION_CONTRACTS_MISSING: 'malformed plan execution receipt shape; receipt-format parser is exercised by the executable verifier',
  PLAN_EXECUTION_DEPLOYMENT_SET_MISMATCH: 'requires a recomputed manifest and plan receipt with a deliberately different deployment set',
  PLAN_EXECUTION_EXTERNAL_SET_MISMATCH: 'requires a V2 external-contract receipt fixture; current successor local plan has no external dependencies',
  PLAN_EXECUTION_HASH_MISMATCH: 'requires mutating a plan identity while retaining a structurally valid receipt',
  PLAN_EXECUTION_IDENTITY_MISMATCH: 'requires supplying a receipt for a different plan family',
  PLAN_EXECUTION_RECEIPT_CONFLICT: 'requires rerunning a deployment key with a content-conflicting immutable receipt file',
  PLAN_EXECUTION_ROOT_MISMATCH: 'requires modifying a receipt body without recomputing its domain-separated root',
  PLAN_EXECUTION_SOURCE_MISMATCH: 'requires recomputing a receipt root after changing a source classification',
  PLAN_EXECUTION_STAGES_MISSING: 'requires a structurally rooted receipt with the stage-results field removed',
  PLAN_EXECUTION_STAGE_MISMATCH: 'requires a rooted receipt whose stage kind or identity differs from the plan',
  PLAN_EXECUTION_STAGE_OUTPUT_MISMATCH: 'requires recomputing the receipt root after substituting a deployed address or receipt',
  PLAN_EXECUTION_UNSUPPORTED_STAGE_CLAIM: 'requires a receipt falsely claiming that an unimplemented configuration/proof stage completed',
  PLAN_STAGE_OUTPUT_RECEIPTS_REQUIRED: 'deploy CLI preflight when a selected plan needs a stage-output receipt directory',
  PLAN_STAGE_OUTPUT_SOURCE_REVISION_REQUIRED: 'deploy CLI preflight when a selected plan needs source provenance for stage outputs',
  RESUME_MISMATCH: 'deploy CLI --resume path against a mismatched existing record',
  VERIFY_OUTPUT_EXISTS: 'verify-live CLI refusal, reachable only after a full live run',
};

describe('ConfigError code coverage', () => {
  it('asserts every emitted code, or documents why it cannot be', () => {
    const emitted = new Set<string>();
    for (const file of tsFiles(SRC)) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/ConfigError\(\s*'([A-Z0-9_]+)'/g)) {
        emitted.add(match[1]!);
      }
    }
    expect(emitted.size).toBeGreaterThan(50);

    const testText = tsFiles(TEST)
      .filter((file) => path.basename(file) !== GUARD)
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    const uncovered = [...emitted].filter((code) => !testText.includes(`'${code}'`)).sort();
    expect(uncovered).toEqual(Object.keys(UNTESTED).sort());
  });
});
