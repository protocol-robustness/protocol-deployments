import { describe, expect, it } from 'vitest';
import { executeBootstrapAction, assertBootstrap } from '../src/deployment/bootstrap';
import type { ResolvedBinding, ResolvedContract } from '../src/canonical';
import { ConfigError } from '../src/errors';
import { FakeTransport, abiWord, fakeSigner } from './fake-chain';

const ADMIN = '0x00000000000000000000000000000000000000aa' as const;
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;

const abi = [
  {
    type: 'function',
    name: 'setAdmin',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'admin', type: 'address' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

function contract(): ResolvedContract {
  return {
    logicalId: 'test/admin',
    scope: 'shared',
    artifactSource: 'sew/deployables',
    artifactName: 'TestAdmin',
    artifact: {
      source: 'sew/deployables',
      package: '@sew/deployables',
      version: '0.1.0',
      sourceRepo: 'sew/sew-protocol',
      sourceCommit: 'c'.repeat(40),
      artifactName: 'TestAdmin',
      artifactPath: 'artifacts/TestAdmin.json',
      fileSha256: 'd'.repeat(64),
      abiSha256: 'e'.repeat(64),
      creationBytecodeSha256: 'f'.repeat(64),
      deployedBytecodeSha256: 'a'.repeat(64),
      abi: abi as unknown as unknown[],
    },
    parameters: [],
    relationships: [],
    deploymentOrder: 0,
    deploymentKind: 'deployment',
    governedByGroups: [],
  };
}

const setAdminArgs: ResolvedBinding[] = [{ kind: 'external-address', name: 'admin' }];

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

function baseInput(transport: FakeTransport) {
  return {
    contract: contract(),
    address: ADMIN,
    function: 'setAdmin',
    args: setAdminArgs,
    addresses: {},
    externalAddresses: { admin: ADMIN },
    transport,
    signer: fakeSigner(DEPLOYER),
  };
}

describe('bootstrap actions', () => {
  it('resolves external-address bindings when building the call', async () => {
    const transitions: string[] = [];
    const result = await executeBootstrapAction({
      ...baseInput(new FakeTransport()),
      onTransition: (t) => {
        transitions.push(t.status);
      },
    });
    expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.blockNumber).toBe(5n);
    expect(transitions).toEqual(['submitted', 'confirmed']);
  });

  it('runs a signer preflight after calldata resolution and before signing or submission', async () => {
    const transport = new FakeTransport();
    const order: string[] = [];
    const signer = {
      ...fakeSigner(DEPLOYER),
      signTransaction: async () => { order.push('sign'); return ('0x' + 'ab'.repeat(64)) as `0x${string}`; },
    };
    const result = await executeBootstrapAction({
      ...baseInput(transport), signer,
      beforeSubmit: (call) => {
        order.push('preflight');
        expect(call.from).toBe(DEPLOYER);
        expect(call.target).toBe(ADMIN);
        expect(call.function).toBe('setAdmin');
        expect(call.args).toEqual([ADMIN]);
        return { evidence: { qualification: 'preflight-verified' } };
      },
    });
    expect(order).toEqual(['preflight', 'sign']);
    expect(result.preSubmitEvidence).toEqual({ qualification: 'preflight-verified' });
  });

  it('does not sign when the signer preflight rejects', async () => {
    let signed = false;
    const input = {
      ...baseInput(new FakeTransport()),
      signer: { ...fakeSigner(DEPLOYER), signTransaction: async () => { signed = true; return ('0x' + 'ab'.repeat(64)) as `0x${string}`; } },
      beforeSubmit: () => { throw new ConfigError('SEAL_PREFLIGHT_REJECTED', 'rejected'); },
    };
    await expectCode(() => executeBootstrapAction(input), 'SEAL_PREFLIGHT_REJECTED');
    expect(signed).toBe(false);
  });

  it('signs only the arguments returned by the verified preflight', async () => {
    const derivedAdmin = '0x00000000000000000000000000000000000000bb' as const;
    let signedData: string | undefined;
    const signer = {
      ...fakeSigner(DEPLOYER),
      signTransaction: async (tx: { data?: string }) => {
        signedData = tx.data;
        return ('0x' + 'ab'.repeat(64)) as `0x${string}`;
      },
    };
    await executeBootstrapAction({
      ...baseInput(new FakeTransport()), signer,
      beforeSubmit: () => ({ args: [derivedAdmin], evidence: { derived: true } }),
    });
    expect(signedData?.toLowerCase().endsWith(derivedAdmin.slice(2))).toBe(true);
  });

  it('refuses parameter bindings in bootstrap scope', async () => {
    const input = { ...baseInput(new FakeTransport()), args: [{ kind: 'parameter', parameter: 'rate' } satisfies ResolvedBinding] };
    await expectCode(() => executeBootstrapAction(input), 'BOOTSTRAP_PARAMETER_UNSUPPORTED');
  });

  it('rejects a function absent from the pinned ABI', async () => {
    const input = { ...baseInput(new FakeTransport()), function: 'notThere' };
    await expectCode(() => executeBootstrapAction(input), 'UNKNOWN_BOOTSTRAP_FUNCTION');
  });

  it('surfaces a reverted receipt', async () => {
    const transport = new FakeTransport({ receipt: { status: 'reverted', blockNumber: 5n } as never });
    await expectCode(() => executeBootstrapAction(baseInput(transport)), 'BOOTSTRAP_REVERTED');
  });

  it('reports an external address that the scope does not carry', async () => {
    const input = { ...baseInput(new FakeTransport()), externalAddresses: {} };
    await expectCode(() => executeBootstrapAction(input), 'UNKNOWN_EXTERNAL_ADDRESS');
  });

  it('times out waiting for a bootstrap receipt', async () => {
    const input = { ...baseInput(new FakeTransport({ receipt: null })), receiptTimeoutMs: 40 };
    await expectCode(() => executeBootstrapAction(input), 'BOOTSTRAP_RECEIPT_TIMEOUT');
  });
});

describe('bootstrap assertions', () => {
  const expectedTrue = abiWord(true);

  it('passes when the observed value matches', async () => {
    const input = {
      ...baseInput(new FakeTransport({ callResult: expectedTrue })),
      function: 'paused',
      args: [] as ResolvedBinding[],
      expected: true,
    };
    await expect(assertBootstrap(input)).resolves.toBeUndefined();
  });

  it('fails closed on a mismatched value', async () => {
    const input = {
      ...baseInput(new FakeTransport({ callResult: expectedTrue })),
      function: 'paused',
      args: [] as ResolvedBinding[],
      expected: false,
    };
    await expectCode(() => assertBootstrap(input), 'BOOTSTRAP_ASSERTION_FAILED');
  });

  it('rejects an unknown assertion function', async () => {
    const input = {
      ...baseInput(new FakeTransport()),
      function: 'missingView',
      args: [] as ResolvedBinding[],
      expected: true,
    };
    await expectCode(() => assertBootstrap(input), 'UNKNOWN_BOOTSTRAP_FUNCTION');
  });
});
