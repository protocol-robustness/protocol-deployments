import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { verifyPrfInitialInputApproval } from '../src/deployment/prf-initial-approval';

function approvalInputs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-initial-approval-'));
  const files = ['manifest.edn', 'packages.edn', 'trusted-context.edn', 'approval.edn'];
  for (const file of files) fs.writeFileSync(path.join(root, file), '{}\n');
  return {
    root,
    input: {
      prfRoot: root,
      manifestPath: files[0]!,
      packageSetPath: files[1]!,
      trustedContextPath: files[2]!,
      approvalPath: files[3]!,
    },
  };
}

function acceptedApprovalOutput(): string {
  const roots = {
    'protocol-genesis': `sha256:${'1'.repeat(64)}`,
    'authority-state': `sha256:${'2'.repeat(64)}`,
    'local-authority-policy': `sha256:${'5'.repeat(64)}`,
    'initial-configuration': `sha256:${'3'.repeat(64)}`,
  };
  return JSON.stringify({
    valid: true,
    qualification: 'authenticated-content-approval',
    source: { valid: true },
    'manifest-root': `sha256:${'a'.repeat(64)}`,
    'canonical-roots': roots,
    'authority-transition-validator-address': `0x${'6'.repeat(40)}`,
    'initial-configuration': { 'verifier-registry/root': `sha256:${'4'.repeat(64)}` },
  });
}

describe('PRF initial-input approval gate', () => {
  it('runs the independent PRF verifier with a separate trusted context before deployment', () => {
    const { root, input } = approvalInputs();
    let observed: { command: string; args: string[]; cwd: string } | undefined;
    let evidence: ReturnType<typeof verifyPrfInitialInputApproval> | undefined;
    try {
      evidence = verifyPrfInitialInputApproval(input, (command, args, options) => {
        observed = { command, args, cwd: options.cwd };
        return { status: 0, stdout: acceptedApprovalOutput(), stderr: '' };
      });
      expect(observed?.command).toBe('clojure');
      expect(observed?.args.slice(0, 4)).toEqual(['-M:test', '-m', 'scripts.deployment.configuration-review', 'verify-json']);
      expect(observed?.args.slice(4)).toEqual([
        'manifest.edn', 'packages.edn', 'trusted-context.edn', 'approval.edn',
      ]);
      expect(observed?.cwd).toBe(root);
      expect(evidence).toMatchObject({
        schema: 'prf-initial-input-approval-verification.v1',
        inputs: [
          { role: 'manifest', path: 'manifest.edn' },
          { role: 'package-set', path: 'packages.edn' },
          { role: 'trusted-context', path: 'trusted-context.edn' },
          { role: 'approval-envelope', path: 'approval.edn' },
        ],
        output: acceptedApprovalOutput(),
      });
      expect(evidence?.manifestRoot).toBe(`sha256:${'a'.repeat(64)}`);
      expect(evidence?.approvedRootBindings).toEqual({
        protocolGenesisRoot: '0x' + '1'.repeat(64),
        authorityStateRoot: '0x' + '2'.repeat(64),
        localAuthorityPolicyRoot: '0x' + '5'.repeat(64),
        initialConfigurationRoot: '0x' + '3'.repeat(64),
        initialVerifierRegistryRoot: '0x' + '4'.repeat(64),
        authorityTransitionValidatorAddress: '0x' + '6'.repeat(40),
      });
      expect(evidence?.outputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence?.inputs.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the verifier rejects or cannot run', () => {
    const { root, input } = approvalInputs();
    try {
      expect(() => verifyPrfInitialInputApproval(input, () => ({ status: 1, stderr: 'approval rejected' })))
        .toThrowError(expect.objectContaining({ code: 'PRF_INITIAL_APPROVAL_REJECTED' }));
      expect(() => verifyPrfInitialInputApproval(input, () => ({ status: null, error: new Error('missing clojure') })))
        .toThrowError(expect.objectContaining({ code: 'PRF_INITIAL_APPROVAL_REJECTED' }));
      expect(() => verifyPrfInitialInputApproval(input, () => ({
        status: 0, stdout: JSON.stringify({ valid: false, qualification: 'approval-rejected', source: { valid: true }, 'manifest-root': `sha256:${'a'.repeat(64)}` }),
      }))).toThrowError(expect.objectContaining({ code: 'PRF_INITIAL_APPROVAL_INVALID_RESULT' }));
      const malformedRoots = JSON.parse(acceptedApprovalOutput()) as Record<string, unknown>;
      (malformedRoots['canonical-roots'] as Record<string, unknown>)['protocol-genesis'] = 'not-a-root';
      expect(() => verifyPrfInitialInputApproval(input, () => ({ status: 0, stdout: JSON.stringify(malformedRoots) })))
        .toThrowError(expect.objectContaining({ code: 'PRF_INITIAL_APPROVAL_INVALID_RESULT' }));
      const malformedValidator = JSON.parse(acceptedApprovalOutput()) as Record<string, unknown>;
      malformedValidator['authority-transition-validator-address'] = '0x0000000000000000000000000000000000000000';
      expect(() => verifyPrfInitialInputApproval(input, () => ({ status: 0, stdout: JSON.stringify(malformedValidator) })))
        .toThrowError(expect.objectContaining({ code: 'PRF_INITIAL_APPROVAL_INVALID_RESULT' }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing approval artifacts before invoking the verifier', () => {
    const { root, input } = approvalInputs();
    fs.unlinkSync(path.join(root, 'approval.edn'));
    try {
      expect(() => verifyPrfInitialInputApproval(input, () => {
        throw new Error('verifier must not run');
      })).toThrowError(expect.objectContaining({ code: 'PRF_INITIAL_APPROVAL_INPUT_MISSING' }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
