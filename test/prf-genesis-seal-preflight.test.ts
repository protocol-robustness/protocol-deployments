import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { verifyPrfGenesisSealPreflight, verifyPrfGenesisSealResult } from '../src/deployment/prf-genesis-seal-preflight';

function inputs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-genesis-seal-'));
  for (const file of ['request.edn', 'trusted.edn']) fs.writeFileSync(path.join(root, file), '{}\n');
  return {
    root,
    base: {
      prfRoot: root, requestPath: 'request.edn', trustedContextPath: 'trusted.edn', rpcUrl: 'http://127.0.0.1:8545',
      genesisAddress: '0x1111111111111111111111111111111111111111',
      authorityAdapterAddress: '0x2222222222222222222222222222222222222222',
      expectedManifestRoot: `sha256:${'a'.repeat(64)}`,
    },
  };
}

const call = {
  from: '0x3333333333333333333333333333333333333333',
  target: '0x1111111111111111111111111111111111111111',
  function: 'sealGenesis',
  args: ['0x' + 'b'.repeat(64), '0x' + 'c'.repeat(64), '0x' + 'd'.repeat(64)],
};

describe('PRF genesis seal signer gate', () => {
  it('runs the independent live gate and binds it to the exact planned call and initial manifest', () => {
    const { root, base } = inputs();
    try {
      const evidence = verifyPrfGenesisSealPreflight({ ...base, expectedCall: { ...call, args: [undefined, ...call.args.slice(1)] } }, (_command, args, options) => {
        expect(args).toContain('--json');
        expect(options.cwd).toBe(root);
        return { status: 0, stdout: JSON.stringify({
          schema: 'prf-chain-instance-seal-preflight.v2',
          qualification: 'approved-inputs-and-live-observations-verified',
          'manifest-root': base.expectedManifestRoot,
          'source-tree-sha256': 'e'.repeat(64),
          'computed-root': 'sha256:' + 'b'.repeat(64),
          'source-file-count': 919,
          'observation-blocks': {},
          'observations-edn': '{:observation {} :preseal-observation {}}',
          'seal-call': { ...call, args: call.args.map((value) => value.slice(2)) },
        }) };
      });
      expect(evidence.computedRoot).toBe('sha256:' + 'b'.repeat(64));
      expect(evidence.sealCall.target).toBe(call.target);
      expect(evidence.derivedArguments[0]).toBe('0x' + 'b'.repeat(64));
      expect(evidence.inputs).toHaveLength(2);
      expect(evidence.outputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(() => verifyPrfGenesisSealPreflight({ ...base, expectedCall: { ...call, args: [...call.args.slice(0, 2), '0x' + 'f'.repeat(64)] } }, () => ({
        status: 0, stdout: JSON.stringify({
          schema: 'prf-chain-instance-seal-preflight.v2', qualification: 'approved-inputs-and-live-observations-verified',
          'manifest-root': base.expectedManifestRoot, 'source-tree-sha256': 'e'.repeat(64), 'computed-root': 'sha256:' + 'b'.repeat(64),
          'seal-call': { ...call, args: call.args.map((value) => value.slice(2)) },
        }),
      }))).toThrowError(expect.objectContaining({ code: 'PRF_GENESIS_SEAL_PREFLIGHT_INVALID_RESULT' }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('requires independently verified receipt and same-block genesis readback', () => {
    const { root, base } = inputs();
    let recordedPreflightPath = '';
    try {
      const evidence = verifyPrfGenesisSealResult({ ...base, transactionHash: '0x' + '1'.repeat(64), expectedGenesisRoot: 'sha256:' + 'b'.repeat(64), preflightOutput: '{"schema":"preflight"}' }, (_command, args) => {
        recordedPreflightPath = args[6]!;
        expect(JSON.parse(fs.readFileSync(recordedPreflightPath, 'utf8'))).toEqual({ schema: 'preflight' });
        return {
        status: 0, stdout: JSON.stringify({
          schema: 'prf-chain-instance-seal-result.v1', qualification: 'seal-receipt-and-readback-verified',
          'manifest-root': base.expectedManifestRoot, 'chain-instance-genesis-root': 'sha256:' + 'b'.repeat(64),
          receipt: { 'transaction-hash': '0x' + '1'.repeat(64), 'block-number': 42, 'block-hash': '0x' + '2'.repeat(64) },
        }),
        };
      });
      expect(evidence.chainInstanceGenesisRoot).toBe('sha256:' + 'b'.repeat(64));
      expect(evidence.preflightOutputSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.inputs).toHaveLength(3);
      expect(fs.existsSync(recordedPreflightPath)).toBe(false);
      expect(() => verifyPrfGenesisSealResult({ ...base, transactionHash: '0x' + '1'.repeat(64), expectedGenesisRoot: 'sha256:' + 'c'.repeat(64), preflightOutput: '{"schema":"preflight"}' }, () => ({
        status: 0, stdout: JSON.stringify({
          schema: 'prf-chain-instance-seal-result.v1', qualification: 'seal-receipt-and-readback-verified',
          'manifest-root': base.expectedManifestRoot, 'chain-instance-genesis-root': 'sha256:' + 'b'.repeat(64), receipt: {},
        }),
      }))).toThrowError(expect.objectContaining({ code: 'PRF_GENESIS_SEAL_RESULT_INVALID' }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
