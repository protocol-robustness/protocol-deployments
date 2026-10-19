import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { verifyPrfSuccessorTransitionApproval, type PrfSuccessorApprovalScope } from '../src/deployment/prf-successor-approval';

const scope: PrfSuccessorApprovalScope = {
  'protocol/genesis-root': `sha256:${'a'.repeat(64)}`,
  'execution/chain-id': 31337,
  'chain-instance-genesis-root': `sha256:${'b'.repeat(64)}`,
  'configuration/parent-root': `sha256:${'c'.repeat(64)}`,
  'configuration/new-root': `sha256:${'d'.repeat(64)}`,
  epoch: 1,
  'entitlement-proof-mode': 1,
  qualification: 'local-only',
};

function fixture() {
  const prfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-successor-approval-'));
  for (const name of ['manifest.edn', 'registry.edn', 'trusted.edn', 'approval.edn']) fs.writeFileSync(path.join(prfRoot, name), name);
  return { prfRoot, manifestPath: 'manifest.edn', verifierRegistryPath: 'registry.edn', trustedContextPath: 'trusted.edn', approvalPath: 'approval.edn' };
}

describe('PRF successor transition approval gate', () => {
  it('retains independent verifier evidence only for the exact expected transition scope', () => {
    const input = fixture();
    const output = JSON.stringify({ valid: true, qualification: 'authenticated-successor-transition',
      'manifest-root': `sha256:${'e'.repeat(64)}`, scope });
    const evidence = verifyPrfSuccessorTransitionApproval(input, scope, (_command, args, options) => {
      expect(args).toContain('verify-json');
      expect(options.cwd).toBe(input.prfRoot);
      return { status: 0, stdout: output };
    });
    expect(evidence.scope).toEqual(scope);
    expect(evidence.manifestRoot).toBe(`sha256:${'e'.repeat(64)}`);
    expect(evidence.inputs.map((entry) => entry.role)).toEqual(['transition-manifest', 'verifier-registry', 'trusted-context', 'approval-envelope']);
  });

  it('rejects a valid approval for a different instance or transition', () => {
    const input = fixture();
    const output = JSON.stringify({ valid: true, qualification: 'authenticated-successor-transition',
      'manifest-root': `sha256:${'e'.repeat(64)}`, scope: { ...scope, 'chain-instance-genesis-root': `sha256:${'f'.repeat(64)}` } });
    expect(() => verifyPrfSuccessorTransitionApproval(input, scope, () => ({ status: 0, stdout: output })))
      .toThrowError(expect.objectContaining({ code: 'PRF_SUCCESSOR_APPROVAL_SCOPE_MISMATCH' }));
  });

  it('fails closed when the detached approval is rejected', () => {
    const input = fixture();
    expect(() => verifyPrfSuccessorTransitionApproval(input, scope, () => ({ status: 1, stdout: '{"valid":false}' })))
      .toThrowError(expect.objectContaining({ code: 'PRF_SUCCESSOR_APPROVAL_REJECTED' }));
  });
});
