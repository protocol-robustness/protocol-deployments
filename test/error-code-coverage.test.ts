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
  APPROVED_ROOT_BINDING_INVALID: 'malformed detached PRF approval output from the external verifier process',
  APPROVED_ROOT_BINDING_TARGET_INVALID: 'approval root binding targets an unapproved constructor field in full CLI preflight',
  BOOTSTRAP_PREFLIGHT_ARGUMENT_MISMATCH: 'pre-submit argument substitution guard in a full bootstrap execution',
  CROSS_PLAN_CONTRACT_SUBSTITUTION: 'redundant post-condition of the plan-execution receipt check, which already binds every deploy-stage output to the manifest and runs first; only reachable if that earlier check is weakened',
  CROSS_PLAN_STAGE_OUTPUT_EVIDENCE_SET: 'requires a resolver run over a selected plan whose cross-plan pins differ from the evidence directory contents; the selected plan files in config/ carry no cross-plan pins yet',
  CROSS_PLAN_STAGE_OUTPUT_LIVE_VERIFICATION_FAILED: 'requires a full deploy CLI run with RPC receipt/runtime evidence disagreeing with the producer output',
  DEPLOYMENT_PLAN_STAGE_OUTPUT_CYCLE: 'requires a self-referential consumer plan hash pin, which would require a cryptographic fixed point',
  DEVNET_NOT_READY: 'requires a pid file naming a live but unresponsive anvil',
  DEVNET_PORT_IN_USE: 'requires a foreign process to already own the devnet port',
  DEVNET_START_TIMEOUT: 'requires anvil to never become ready (up to 20s)',
  FEE_ESTIMATE_UNAVAILABLE: 'requires an RPC returning neither EIP-1559 fees nor a legacy gas price',
  FORK_SOURCE_UNSET: 'requires a base-fork environment and runtime fixture',
  PLAN_EXECUTABLE_PREFIX_UNAVAILABLE: 'deploy CLI refusal when the authenticated plan has no executable contract prefix',
  PLAN_EXECUTION_CONTRACTS_MISSING: 'malformed plan execution receipt shape; receipt-format parser is exercised by the executable verifier',
  PLAN_EXECUTION_DEPLOYMENT_SET_MISMATCH: 'requires a recomputed manifest and plan receipt with a deliberately different deployment set',
  PLAN_EXECUTION_DERIVATION_EVIDENCE_MISMATCH: 'requires a rooted receipt with falsified independent PRF derivation evidence',
  PLAN_EXECUTION_DERIVATION_OUTPUT_MISMATCH: 'requires a rooted receipt whose canonical derivation output differs from PRF evidence',
  PLAN_EXECUTION_EXTERNAL_SET_MISMATCH: 'cross-plan fixtures build a V2 external set that agrees with its plan by construction; mutating it to disagree exercises plan-execution reconciliation rather than cross-plan pinning',
  PLAN_EXECUTION_GENESIS_DERIVATION_MISMATCH: 'requires a deployment receipt whose chain-instance root differs from independent PRF recomputation',
  PLAN_EXECUTION_GENESIS_SEAL_MISMATCH: 'requires a deployment receipt whose seal transaction or readback contradicts PRF evidence',
  PLAN_EXECUTION_HASH_MISMATCH: 'requires mutating a plan identity while retaining a structurally valid receipt',
  PLAN_EXECUTION_IDENTITY_MISMATCH: 'requires supplying a receipt for a different plan family',
  PLAN_EXECUTION_RECEIPT_CONFLICT: 'requires rerunning a deployment key with a content-conflicting immutable receipt file',
  PLAN_EXECUTION_ROOT_MISMATCH: 'requires modifying a receipt body without recomputing its domain-separated root',
  PLAN_EXECUTION_SPEC_MISMATCH: 'requires a full plan-execution verifier CLI run with a retained resolved-spec digest that differs from the receipt',
  PLAN_EXECUTION_SOURCE_MISMATCH: 'requires recomputing a receipt root after changing a source classification',
  PLAN_EXECUTION_STAGES_MISSING: 'requires a structurally rooted receipt with the stage-results field removed',
  PLAN_EXECUTION_STAGE_MISMATCH: 'requires a rooted receipt whose stage kind or identity differs from the plan',
  PLAN_EXECUTION_STAGE_OUTPUT_MISMATCH: 'requires recomputing the receipt root after substituting a deployed address or receipt',
  PLAN_EXECUTION_UNSUPPORTED_STAGE_CLAIM: 'requires a receipt falsely claiming that an unimplemented configuration/proof stage completed',
  PLAN_STAGE_OUTPUT_RECEIPTS_REQUIRED: 'deploy CLI preflight when a selected plan needs a stage-output receipt directory',
  PLAN_STAGE_OUTPUT_SOURCE_REVISION_REQUIRED: 'deploy CLI preflight when a selected plan needs source provenance for stage outputs',
  PRF_EMPTY_REGISTRY_ACTION_INVALID: 'deploy CLI guard when the declared empty-registry action or verified deployment facts are absent',
  PRF_EMPTY_REGISTRY_GENESIS_NOT_SEALED: 'deploy CLI guard when the chain-instance genesis seal receipt is absent',
  PRF_EMPTY_REGISTRY_ROOT_MISMATCH: 'deploy CLI guard when Solidity empty-registry derivation differs from authenticated PRF approval',
  PRF_EMPTY_REGISTRY_SEAL_RECEIPT_MISSING: 'deploy CLI refusal when an existing sealed registry has no retained successful sealing receipt',
  PRF_EMPTY_REGISTRY_SEAL_CALL_MISMATCH: 'pre-submit guard for an altered signer or root in the empty-registry sealing call',
  PRF_GENESIS_SEAL_ADAPTER_BINDING_REQUIRED: 'deploy CLI guard when genesis sealing does not bind the authority adapter',
  PRF_GENESIS_SEAL_INPUT_INVALID: 'malformed request passed to the independent PRF genesis-seal verifier',
  PRF_GENESIS_SEAL_PREFLIGHT_REJECTED: 'independent PRF genesis-seal verifier rejects deployment observations',
  PRF_GENESIS_SEAL_PREFLIGHT_REQUIRED: 'deploy CLI refusal to sign genesis sealing without authenticated preflight evidence',
  PRF_GENESIS_SEAL_RESULT_REJECTED: 'independent PRF verifier rejects observed genesis transaction or readback facts',
  PRF_GENESIS_SEAL_ROOT_OVERRIDE_FORBIDDEN: 'deploy CLI refusal to sign a configured non-sentinel genesis root',
  PRF_INITIAL_APPROVAL_INPUT_INVALID: 'malformed request passed to the independent PRF initial-approval verifier',
  PRF_INITIAL_APPROVAL_REQUIRED: 'deploy CLI refusal to begin bounded deployment without detached approval',
  PRF_VERIFIER_REGISTRY_DERIVATION_INPUT_MISSING: 'deploy CLI guard when verified verifier closure or registry deployment facts are absent',
  PRF_VERIFIER_REGISTRY_DERIVATION_INVALID: 'malformed request passed to PRF verifier-registry derivation',
  PRF_VERIFIER_REGISTRY_DERIVATION_REJECTED: 'PRF derivation or Solidity equality check rejects a proposed successor registry root',
  PRF_SUCCESSOR_APPROVAL_INPUT_INVALID: 'transition approval CLI refuses a non-regular input file before invoking PRF',
  PRF_SUCCESSOR_APPROVAL_INPUT_MISSING: 'transition approval CLI refuses when an expected detached review artifact is unavailable',
  PRF_SUCCESSOR_APPROVAL_INVALID_RESULT: 'independent PRF transition verifier returns malformed structured output',
  PRF_SUCCESSOR_CONFIGURATION_DERIVATION_INPUT_MISSING: 'deploy CLI cannot derive C1 without retained approved C0, sealed genesis artifact or successor registry root',
  PRF_SUCCESSOR_REGISTRATION_RECEIPT_REQUIRED: 'deploy CLI refuses registry sealing without retained successor-registration evidence',
  PRF_SUCCESSOR_REGISTRY_APPROVAL_REQUIRED: 'deploy CLI refuses registry mutation without detached transition approval and declared actions',
  PRF_SUCCESSOR_REGISTRY_APPROVAL_SCOPE_MISMATCH: 'deploy CLI refuses when retained approval does not bind the derived C0-to-C1 transition',
  PRF_SUCCESSOR_REGISTRY_CALL_MISMATCH: 'pre-submit guard for a registration call differing from the approved entry or governor',
  PRF_SUCCESSOR_REGISTRY_READBACK_FAILED: 'live chain registry entry readback differs from the independently derived verifier entry',
  PRF_SUCCESSOR_REGISTRY_ROOT_MISMATCH: 'live Solidity registry root differs from PRF or the retained cross-language derivation',
  PRF_SUCCESSOR_REGISTRY_SEAL_CALL_MISMATCH: 'pre-submit guard for a registry seal call differing from the approved root or governor',
  PRF_SUCCESSOR_REGISTRY_SEAL_READBACK_FAILED: 'deploy CLI refuses when a successful seal transaction is not reflected in registry state',
  PRF_SUCCESSOR_REGISTRY_STATE_INVALID: 'deploy CLI refuses sealing unless the registry has exactly the registered approved entry',
  PRF_SUCCESSOR_REGISTRY_UNRECORDED_STATE: 'deploy CLI refuses reconciling already-mutated registry state without a durable transaction receipt',
  PUBLIC_PLACEHOLDER_BINDING: 'resolver refusal when an environment attempts to inject a placeholder canonical root',
  RESUME_MISMATCH: 'deploy CLI --resume path against a mismatched existing record',
  VERIFIER_RUNTIME_CLOSURE_MISMATCH: 'standalone plan verifier rejects a retained closure mismatch after independent RPC replay; exercised by the full CLI verification path',
  VERIFIER_RUNTIME_CLOSURE_FAILED: 'deploy CLI refusal when observed adapter or verifier runtime differs from the pinned closure',
  VERIFY_OUTPUT_EXISTS: 'verify-live CLI refusal, reachable only after a full live run',
  PRF_CANONICAL_ROOT_INVALID: 'malformed nonzero canonical-root input rejected by bounded root normalization',
  PRF_AUTHORITY_TRANSITION_INPUT_INVALID: 'malformed transition verifier request rejected by the PRF subprocess boundary',
  PRF_AUTHORITY_TRANSITION_INPUT_REQUIRED: 'bounded deployment refuses authority transition without its separate signed request inputs',
  PRF_SUCCESSOR_APPROVAL_REQUIRED: 'bounded deployment refuses successor registry and C1 actions without transition approval',
  PRF_AUTHORITY_TRANSITION_BINDING_REQUIRED: 'bounded deployment refuses an authority transition missing a required instance or root binding',
  PRF_AUTHORITY_TRANSITION_BINDING_MISMATCH: 'retained authority transition evidence conflicts with the verified live deployment bindings',
  PRF_AUTHORITY_TRANSITION_PREFLIGHT_REQUIRED: 'authority transition cannot be submitted without independent PRF verification evidence',
  PRF_AUTHORITY_TRANSITION_EVIDENCE_REQUIRED: 'already-mutated authority state cannot be reconciled without retained transition evidence',
  PRF_AUTHORITY_TRANSITION_MUTATION_MISMATCH: 'planned authority mutation differs from the independently verified mutation payload',
  PRF_AUTHORITY_TRANSITION_PLAN_ACTION_INVALID: 'plan does not declare the exact authority transition action accepted by the gate',
  PRF_AUTHORITY_TRANSITION_UNRECORDED_STATE: 'live authority state changed without a matching durable transaction receipt',
  PRF_AUTHORITY_TRANSITION_CALL_MISMATCH: 'pre-submit authority call differs from the approved transition and signer scope',
  PRF_AUTHORITY_TRANSITION_READBACK_FAILED: 'post-transaction authority root or revision differs from verified transition output',
  PRF_SUCCESSOR_CONFIGURATION_APPROVAL_REQUIRED: 'C1 application is refused without the distinct successor approval',
  PRF_SUCCESSOR_CONFIGURATION_EVIDENCE_REQUIRED: 'C1 application lacks retained derivation, registry seal or transition evidence',
  PRF_SUCCESSOR_CONFIGURATION_DERIVATION_MISSING: 'C1 application is refused when independent successor derivation evidence is absent',
  PRF_SUCCESSOR_CONFIGURATION_PRESTATE_MISMATCH: 'configuration executor prestate differs from approved C0, epoch zero or genesis instance',
  PRF_SUCCESSOR_CONFIGURATION_NOT_AUTHORIZED: 'configuration executor rejected the scoped C0 to C1 transition authorization',
  PRF_SUCCESSOR_CONFIGURATION_CALL_MISMATCH: 'pre-submit configuration call differs from the independently derived approved transition',
  PRF_SUCCESSOR_CONFIGURATION_READBACK_FAILED: 'post-transaction configuration root, epoch or decision-consumption readback disagrees',
  PRF_POST_C1_DEPLOYMENT_GATE_REQUIRED: 'admission and protected contracts cannot deploy before verified C1 application evidence',
  BOOTSTRAP_ARGUMENT_SOURCE_INVALID: 'bootstrap argument references an undeclared or malformed stage output source',
  CROSS_PLAN_STAGE_OUTPUT_UNDECLARED: 'producer plan fails to declare the contract output used by a cross-plan pin',
  PLAN_EXECUTION_SUCCESSOR_APPROVAL_MISMATCH: 'verified transition-approval stage conflicts with the retained PRF verifier output or scoped derivation',
  PLAN_EXECUTION_EMPTY_REGISTRY_SEAL_MISMATCH: 'empty-registry seal stage conflicts with approved root, transaction or Solidity projection evidence',
  PLAN_EXECUTION_SUCCESSOR_REGISTRATION_MISMATCH: 'successor registration stage conflicts with approved verifier entry or transaction evidence',
  PLAN_EXECUTION_SUCCESSOR_REGISTRY_SEAL_MISMATCH: 'successor-registry seal stage conflicts with registration, approval or seal transaction evidence',
  PLAN_EXECUTION_AUTHORITY_TRANSITION_MISMATCH: 'authority transition stage conflicts with the verified mutation envelope or application transaction',
  PRF_AUTHORITY_TRANSITION_INPUT_MISSING: 'required authority-transition input file is absent before bounded deployment execution',
  PLAN_ADMISSION_SNAPSHOT_INVALID: 'post-C1 admission binding cannot be formed from the applied configuration root and epoch',
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
