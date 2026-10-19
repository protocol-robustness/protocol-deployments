import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { DeploymentManifest } from '../src/deployment/manifest';
import { replayRetainedPrfEvidence } from '../src/deployment/prf-evidence-replay';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-evidence-replay-test-'));
  const trustedContextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-trusted-context-test-'));
  const roles = ['manifest', 'package-set', 'trusted-context', 'approval-envelope'];
  const inputs = roles.map((role, index) => {
    const relative = `evidence/input-${index}.edn`;
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `input-${index}`);
    if (role === 'trusted-context' || role === 'approval-envelope') {
      const trustedFile = path.join(trustedContextRoot, relative);
      fs.mkdirSync(path.dirname(trustedFile), { recursive: true });
      fs.writeFileSync(trustedFile, `input-${index}`);
    }
    return { role, path: relative, sha256: sha(`input-${index}`) };
  });
  const output = JSON.stringify({ valid: true, qualification: 'authenticated-content-approval' });
  const manifest = { finalAssertions: [{ id: 'prf-initial-input-approval', status: 'passed', detail: JSON.stringify({
    inputs, output, outputSha256: sha(output),
  }) }] } as unknown as DeploymentManifest;
  return { root, trustedContextRoot, manifest };
}

describe('independent retained PRF evidence replay', () => {
  it('replays the fixed initial-approval verifier using content-pinned input files', () => {
    const f = fixture();
    try {
      const count = replayRetainedPrfEvidence(f.manifest, f.root, f.trustedContextRoot, undefined, (command, args, options) => {
        expect(command).toBe('clojure');
        expect(args.slice(0, 4)).toEqual(['-M:test', '-m', 'scripts.deployment.configuration-review', 'verify-json']);
        expect(args[6]).toBe(path.join(f.trustedContextRoot, 'evidence/input-2.edn'));
        expect(args[7]).toBe(path.join(f.trustedContextRoot, 'evidence/input-3.edn'));
        expect(options.cwd).toBe(f.root);
        return { status: 0, stdout: JSON.stringify({ valid: true, qualification: 'authenticated-content-approval' }) };
      });
      expect(count).toBe(1);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(f.trustedContextRoot, { recursive: true, force: true }); }
  });

  it('replays approval artifacts stored under the separately supplied trusted root', () => {
    const f = fixture();
    try {
      const assertion = (f.manifest.finalAssertions as unknown as Array<{ detail: string }>)[0]!;
      const detail = JSON.parse(assertion.detail) as { inputs: Array<{ path: string }>; output: string; outputSha256: string };
      for (let index = 0; index < 2; index += 1) {
        const source = path.join(f.root, detail.inputs[index]!.path);
        const target = path.join(f.trustedContextRoot, `evidence/input-${index}.edn`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        fs.unlinkSync(source);
        detail.inputs[index]!.path = path.relative(f.root, target);
      }
      assertion.detail = JSON.stringify(detail);
      const count = replayRetainedPrfEvidence(f.manifest, f.root, f.trustedContextRoot, undefined, (_command, args) => {
        expect(args[4]).toBe(path.join(f.trustedContextRoot, 'evidence/input-0.edn'));
        expect(args[5]).toBe(path.join(f.trustedContextRoot, 'evidence/input-1.edn'));
        return { status: 0, stdout: JSON.stringify({ valid: true, qualification: 'authenticated-content-approval' }) };
      });
      expect(count).toBe(1);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(f.trustedContextRoot, { recursive: true, force: true }); }
  });

  it('rejects changed files and verifier output that no longer reproduces', () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.root, 'evidence/input-0.edn'), 'substituted');
      expect(() => replayRetainedPrfEvidence(f.manifest, f.root, f.trustedContextRoot, undefined, () => ({ status: 0, stdout: '{}' })))
        .toThrow(expect.objectContaining({ code: 'PLAN_EXECUTION_PRF_EVIDENCE_MISMATCH' }));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(f.trustedContextRoot, { recursive: true, force: true }); }
  });

  it('rejects retained-input symlinks that escape the source root', () => {
    const f = fixture();
    const outside = path.join(os.tmpdir(), `prf-evidence-outside-${process.pid}.edn`);
    try {
      fs.writeFileSync(outside, 'input-0');
      const retained = path.join(f.root, 'evidence/input-0.edn');
      fs.unlinkSync(retained);
      fs.symlinkSync(outside, retained);
      expect(() => replayRetainedPrfEvidence(f.manifest, f.root, f.trustedContextRoot, undefined, () => ({ status: 0, stdout: '{}' })))
        .toThrow(expect.objectContaining({ code: 'PLAN_EXECUTION_PRF_EVIDENCE_MISMATCH' }));
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
      fs.rmSync(f.trustedContextRoot, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it('replays the seal-result verifier against its retained preflight, transaction and RPC', () => {
    const f = fixture();
    try {
      const requestFile = path.join(f.trustedContextRoot, 'evidence/seal-request.edn');
      const contextFile = path.join(f.trustedContextRoot, 'evidence/seal-context.edn');
      const requestPath = path.relative(f.root, requestFile);
      const contextPath = path.relative(f.root, contextFile);
      fs.mkdirSync(path.dirname(requestFile), { recursive: true });
      fs.writeFileSync(requestFile, '{:request true}');
      fs.mkdirSync(path.dirname(contextFile), { recursive: true });
      fs.writeFileSync(contextFile, '{:trusted true}');
      const preflightOutput = JSON.stringify({ schema: 'prf-chain-instance-seal-preflight.v2', computedRoot: '0x' + '11'.repeat(32) });
      const sealOutput = JSON.stringify({ schema: 'prf-chain-instance-seal-result.v1', chainInstanceGenesisRoot: '0x' + '11'.repeat(32) });
      const finalAssertions = [...(f.manifest.finalAssertions as unknown as Array<Record<string, unknown>>),
        { id: 'prf-genesis-seal-preflight', status: 'passed', detail: JSON.stringify({ output: preflightOutput, outputSha256: sha(preflightOutput) }) },
        { id: 'prf-genesis-seal-result', status: 'passed', detail: JSON.stringify({
          output: sealOutput, outputSha256: sha(sealOutput),
          inputs: [
            { role: 'preflight-request', path: requestPath, sha256: sha('{:request true}') },
            { role: 'trusted-context', path: contextPath, sha256: sha('{:trusted true}') },
            { role: 'preflight-verifier-output', path: 'captured-before-signing', sha256: sha(preflightOutput) },
          ],
        }) },
      ];
      const manifest = {
        ...f.manifest,
        finalAssertions,
        contracts: [
          { logicalId: 'prf/genesis', address: '0x' + '22'.repeat(20) },
          { logicalId: 'prf/governance-authority', address: '0x' + '33'.repeat(20) },
        ],
        bootstrapActions: [{ id: 'prf/seal-genesis', status: 'verified', transactionHash: '0x' + '44'.repeat(32) }],
      } as unknown as DeploymentManifest;
      const count = replayRetainedPrfEvidence(manifest, f.root, f.trustedContextRoot, 'http://127.0.0.1:8545', (_command, args) => {
        if (args.some((arg) => arg.endsWith('configuration-review'))) return { status: 0, stdout: JSON.stringify({ valid: true, qualification: 'authenticated-content-approval' }) };
        expect(args).toContain('verify-seal-result');
        expect(args).toContain('0x' + '44'.repeat(32));
        expect(args).toContain('0x' + '22'.repeat(20));
        expect(args).toContain('0x' + '33'.repeat(20));
        return { status: 0, stdout: sealOutput };
      });
      expect(count).toBe(2);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); fs.rmSync(f.trustedContextRoot, { recursive: true, force: true }); }
  });
});
