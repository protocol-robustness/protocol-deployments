import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { keccak256Hex } from '../src/artifacts/hash';
import { canonicalJson } from '../src/canonical-json';
import { ConfigError } from '../src/errors';
import type { ResolvedSpec } from '../src/canonical';
import {
  LIVE_VERIFICATION_DOMAIN,
  verifyLiveDeployment,
  type LiveVerificationV1,
} from '../src/deployment/live-verification';
import {
  assertManifestVerified,
  computeManifestRoot,
  registryBindingCandidate,
  type DeploymentManifestV1,
} from '../src/deployment/manifest';
import { artifactIdentityOf } from '../src/deployment/record';
import { FakeTransport, abiWord } from './fake-chain';
import { bundle, resolveEdn } from './helpers';

const DEPLOY_BLOCK: Hex = ('0x' + 'd'.repeat(64)) as Hex;
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TOKEN = '0x0000000000000000000000000000000000000001' as const;

const resolved = resolveEdn();
const spec = resolved.spec;
const tokenContract = spec.contracts['shared/gov-token'];
if (!tokenContract) throw new Error('test fixture is missing shared/gov-token');
const tokenIdentity = artifactIdentityOf(tokenContract);
const tokenRuntime = bundle()
  .loadArtifact(tokenIdentity.source, tokenIdentity.package, tokenIdentity.version, tokenIdentity.artifactName)
  .artifact.deployedBytecode.toLowerCase() as Hex;

function manifest(overrides: Partial<DeploymentManifestV1> = {}): DeploymentManifestV1 {
  return {
    type: 'protocol-deployment-manifest/v1',
    architectureSpecHash: '0xarchitecture',
    executionSpecHash: '0xexecution',
    deploymentId: 'local',
    chain: { id: 31337, blockNumber: '12', blockHash: DEPLOY_BLOCK },
    deployer: DEPLOYER,
    contracts: [{
      logicalId: 'shared/gov-token',
      address: TOKEN,
      artifact: tokenIdentity,
      deploymentTx: ('0x' + '1'.repeat(64)) as Hex,
      blockNumber: '10',
    }],
    bootstrapActions: [{ id: 'bind', status: 'verified', transactionHash: ('0x' + '2'.repeat(64)) as Hex, blockNumber: '11' }],
    finalAssertions: [],
    ...overrides,
  };
}

function healthyTransport(overrides: Partial<ConstructorParameters<typeof FakeTransport>[0]> = {}): FakeTransport {
  return new FakeTransport({
    chainId: 31337,
    blockHashes: { '12': DEPLOY_BLOCK },
    latest: { number: 12n, hash: ('0x' + 'e'.repeat(64)) as Hex },
    code: () => tokenRuntime,
    ...overrides,
  });
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

function expectSyncCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

function withAssertions(assertions: NonNullable<ResolvedSpec['deployment']['bootstrapAssertions']>): ResolvedSpec {
  return { ...spec, deployment: { ...spec.deployment, bootstrapAssertions: assertions } };
}

const decimalsEntry = (tokenContract.artifact.abi as unknown as Array<Record<string, unknown>>)
  .find((entry) => entry.type === 'function' && entry.name === 'decimals');
if (!decimalsEntry) throw new Error('SewToken fixture is missing decimals()');

describe('live verification of a sealed manifest', () => {
  it('re-verifies a healthy manifest and pins the verification root domain', async () => {
    const result: LiveVerificationV1 = await verifyLiveDeployment(manifest(), healthyTransport(), spec, bundle());
    expect(result.result).toBe('passed');
    expect(result.contracts).toEqual([
      { logicalId: 'shared/gov-token', address: TOKEN, artifactName: 'SewToken', result: 'passed' },
    ]);
    expect(result.chain).toEqual({ id: 31337, blockNumber: '12', blockHash: ('0x' + 'e'.repeat(64)) as Hex });
    expect(result.manifestRoot).toBe(computeManifestRoot(manifest()));

    expect(LIVE_VERIFICATION_DOMAIN).toBe('protocol-deployment-verification:v1:');
    const { verificationRoot, ...body } = result;
    expect(verificationRoot).toBe(`0x${keccak256Hex(`${LIVE_VERIFICATION_DOMAIN}${canonicalJson(body)}`)}`);
    expect(verificationRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic for identical evidence and changes when the chain does not', async () => {
    const first = await verifyLiveDeployment(manifest(), healthyTransport(), spec, bundle());
    const second = await verifyLiveDeployment(manifest(), healthyTransport(), spec, bundle());
    expect(second.verificationRoot).toBe(first.verificationRoot);

    const moved = await verifyLiveDeployment(
      manifest(),
      healthyTransport({ latest: { number: 13n, hash: ('0x' + 'c'.repeat(64)) as Hex } }),
      spec,
      bundle(),
    );
    expect(moved.verificationRoot).not.toBe(first.verificationRoot);
  });

  it('fails closed on an unverified manifest', async () => {
    await expectCode(
      () => verifyLiveDeployment(manifest({ bootstrapActions: [{ id: 'bind', status: 'submitted' }] }), healthyTransport(), spec, bundle()),
      'MANIFEST_UNVERIFIED_BOOTSTRAP',
    );
    await expectCode(
      () => verifyLiveDeployment(manifest({ finalAssertions: [{ id: 'bound', status: 'failed', verifiedAt: 'now' }] }), healthyTransport(), spec, bundle()),
      'MANIFEST_FAILED_ASSERTIONS',
    );
    await expectCode(
      () => verifyLiveDeployment(manifest({ chain: { ...manifest().chain, blockHash: undefined as never } }), healthyTransport(), spec, bundle()),
      'MANIFEST_INCOMPLETE',
    );
  });

  it('refuses a chain id that differs from the manifest', async () => {
    await expectCode(
      () => verifyLiveDeployment(manifest(), healthyTransport({ chainId: 1 }), spec, bundle()),
      'CHAIN_ID_MISMATCH',
    );
  });

  it('refuses a deployment block whose hash no longer matches', async () => {
    await expectCode(
      () => verifyLiveDeployment(manifest(), healthyTransport({ blockHashes: { '12': ('0x' + 'a'.repeat(64)) as Hex } }), spec, bundle()),
      'MANIFEST_BLOCK_MISMATCH',
    );
  });

  it('refuses a manifest sealed ahead of the chain tip', async () => {
    await expectCode(
      () => verifyLiveDeployment(manifest(), healthyTransport({ latest: { number: 5n, hash: ('0x' + 'b'.repeat(64)) as Hex } }), spec, bundle()),
      'MANIFEST_BLOCK_AHEAD',
    );
  });

  it('refuses absent or mismatched runtime code', async () => {
    await expectCode(
      () => verifyLiveDeployment(manifest(), healthyTransport({ code: () => '0x' }), spec, bundle()),
      'RUNTIME_CODE_MISSING',
    );
    await expectCode(
      () => verifyLiveDeployment(manifest(), healthyTransport({ code: () => ('0x' + '00'.repeat(64)) as Hex }), spec, bundle()),
      'RUNTIME_CODE_MISMATCH',
    );
  });

  it('requires every recorded final assertion to be observed again', async () => {
    const recorded = { id: 'bound', status: 'passed' as const, verifiedAt: '2026-01-01T00:00:00.000Z' };
    await expectCode(
      () => verifyLiveDeployment(manifest({ finalAssertions: [recorded] }), healthyTransport(), spec, bundle()),
      'LIVE_ASSERTION_GAP',
    );
  });

  it('re-evaluates declared assertions and fails on a mismatched value', async () => {
    const assertions = [{
      id: 'decimals-bound',
      target: 'shared/gov-token',
      function: 'decimals',
      args: [],
      expected: 18,
    }];
    const healthy = withAssertions(assertions);
    await expectCode(
      () => verifyLiveDeployment(
        manifest({ finalAssertions: [{ id: 'decimals-bound', status: 'passed', verifiedAt: 'now' }] }),
        healthyTransport({ callResult: abiWord(6) }),
        healthy,
        bundle(),
      ),
      'BOOTSTRAP_ASSERTION_FAILED',
    );

    const verified = await verifyLiveDeployment(
      manifest({ finalAssertions: [{ id: 'decimals-bound', status: 'passed', verifiedAt: 'now' }] }),
      healthyTransport({ callResult: abiWord(18) }),
      healthy,
      bundle(),
    );
    expect(verified.assertions).toEqual([
      { id: 'decimals-bound', target: 'shared/gov-token', function: 'decimals', expected: '18', observed: '18', result: 'passed' },
    ]);
  });

  it('rejects an assertion target or function outside the pinned spec', async () => {
    await expectCode(
      () => verifyLiveDeployment(
        manifest(),
        healthyTransport(),
        withAssertions([{ id: 'ghost', target: 'ghost/contract', function: 'anything', args: [], expected: true }]),
        bundle(),
      ),
      'UNRESOLVED_CONTRACT_ADDRESS',
    );
    await expectCode(
      () => verifyLiveDeployment(
        manifest(),
        healthyTransport(),
        withAssertions([{ id: 'nope', target: 'shared/gov-token', function: 'notAFunction', args: [], expected: true }]),
        bundle(),
      ),
      'UNKNOWN_BOOTSTRAP_FUNCTION',
    );
  });
});

describe('manifest completeness gate', () => {
  it('rejects an empty manifest and one without a deployment block hash', () => {
    expectSyncCode(() => assertManifestVerified(manifest({ contracts: [] })), 'MANIFEST_INCOMPLETE');
    expectSyncCode(() => assertManifestVerified(manifest({ chain: { ...manifest().chain, blockHash: undefined as never } })), 'MANIFEST_INCOMPLETE');
  });

  it('rejects incomplete deployment facts and missing artifact identity', () => {
    const brokenFact = manifest();
    brokenFact.contracts = [{ ...brokenFact.contracts[0]!, blockNumber: '' }];
    expectSyncCode(() => assertManifestVerified(brokenFact), 'MANIFEST_INCOMPLETE');

    const noIdentity = manifest();
    noIdentity.contracts = [{ ...noIdentity.contracts[0]!, artifact: { ...tokenIdentity, runtimeBytecodeSha256: '' } }];
    expectSyncCode(() => assertManifestVerified(noIdentity), 'MANIFEST_INCOMPLETE');
  });

  it('rejects unverified bootstrap actions and failed final assertions by code', () => {
    expectSyncCode(
      () => assertManifestVerified(manifest({ bootstrapActions: [{ id: 'bind', status: 'failed' }] })),
      'MANIFEST_UNVERIFIED_BOOTSTRAP',
    );
    expectSyncCode(
      () => assertManifestVerified(manifest({ finalAssertions: [{ id: 'bound', status: 'failed', verifiedAt: 'now' }] })),
      'MANIFEST_FAILED_ASSERTIONS',
    );
  });

  it('rejects a registry root that the manifest does not carry', () => {
    expectSyncCode(() => registryBindingCandidate(manifest(), ['prf/missing-root']), 'MANIFEST_ROOT_MISSING');
  });
});
