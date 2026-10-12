import { describe, expect, it } from 'vitest';
import { hexToBytes, type Hex } from 'viem';
import { keccak256Hex } from '../src/artifacts/hash';
import { materializeExecutionSpec } from '../src/deployment/execution-spec';
import { verifyExternalContracts } from '../src/deployment/external-contracts';
import { verifyLiveDeployment } from '../src/deployment/live-verification';
import type { DeploymentManifestV1, DeploymentManifestV2 } from '../src/deployment/manifest';
import { artifactIdentityOf } from '../src/deployment/record';
import { ConfigError } from '../src/errors';
import { FakeTransport, abiWord } from './fake-chain';
import { bundle, resolveEdn } from './helpers';

const TOKEN = '0x62BD47154D0b5Fe435F220E1294405040102b2ba' as const;
const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const BASELINE_BLOCK: Hex = (`0x${'a'.repeat(64)}`) as Hex;
const EXTERNAL_ENVIRONMENT = `
{:schemaVersion 1 :environment :external-token-test
 :chain {:logicalRole :local :chainId 31337 :kind :local}
 :externalContracts {:shared/gov-token {:address "${TOKEN}"}}
 :bootstrapAssertions
 [{:id :token/votes-interface :target :shared/gov-token :function "getVotes"
   :args [{:literal "0x0000000000000000000000000000000000000000"}] :expected 0N}]
 :deploymentOrder [:shared/timelock :shared/governor :sew/escrow :prf/verifier]}`;

const resolved = resolveEdn({ environment: EXTERNAL_ENVIRONMENT });
const token = resolved.spec.contracts['shared/gov-token']!;
const tokenRuntime = bundle()
  .loadArtifact(token.artifactSource, token.artifact.package, token.artifact.version, token.artifactName)
  .artifact.deployedBytecode.toLowerCase() as Hex;

function transport(overrides: ConstructorParameters<typeof FakeTransport>[0] = {}) {
  return new FakeTransport({
    chainId: 31337,
    latest: { number: 50n, hash: BASELINE_BLOCK },
    blockHashes: { '50': BASELINE_BLOCK },
    code: () => tokenRuntime,
    callResult: abiWord(0),
    ...overrides,
  });
}

async function expectConfigCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).code).toBe(code);
    return;
  }
  throw new Error(`expected ConfigError ${code}`);
}

describe('external contract dependencies', () => {
  it('verifies the pinned code and declared capability before deployments', async () => {
    expect(resolved.spec.contracts['shared/gov-token']?.deploymentKind).toBe('external');
    expect(resolved.spec.deployment.steps.map((step) => step.logicalId)).not.toContain('shared/gov-token');

    const observation = await verifyExternalContracts(resolved.spec, bundle(), transport());
    expect(observation).toHaveLength(1);
    expect(observation[0]).toMatchObject({
      logicalId: 'shared/gov-token',
      address: TOKEN,
      artifact: { artifactName: 'SewToken' },
      observedRuntimeCodeKeccak256: `0x${keccak256Hex(hexToBytes(tokenRuntime))}`,
      observedAt: { blockNumber: '50', blockHash: BASELINE_BLOCK },
    });
  });

  it('materializes the external token address into dependent deployment arguments', () => {
    const governor = resolved.spec.contracts['shared/governor']!;
    const spec = {
      ...resolved.spec,
      contracts: {
        ...resolved.spec.contracts,
        'shared/governor': {
          ...governor,
          constructorBindings: { token: { kind: 'contract-address' as const, contract: 'shared/gov-token' } },
        },
      },
    };
    const { executionSpec } = materializeExecutionSpec(spec, resolved.specHash, DEPLOYER);
    expect(executionSpec.contracts['shared/governor']?.constructorBindings?.token).toBe(TOKEN);
  });

  it('fails closed on wrong chain, missing code, and code that differs from the pinned artifact', async () => {
    await expectConfigCode(verifyExternalContracts(resolved.spec, bundle(), transport({ chainId: 1 })), 'CHAIN_ID_MISMATCH');
    await expectConfigCode(verifyExternalContracts(resolved.spec, bundle(), transport({ code: () => '0x' })), 'EXTERNAL_CONTRACT_CODE_MISSING');
    await expectConfigCode(verifyExternalContracts(resolved.spec, bundle(), transport({ code: () => (`0x${'00'.repeat(64)}`) as Hex })), 'EXTERNAL_CONTRACT_CODE_MISMATCH');
  });

  it('fails before deployment if an external dependency does not satisfy its declared capability assertion', async () => {
    await expectConfigCode(
      verifyExternalContracts(resolved.spec, bundle(), transport({ callResult: abiWord(1) })),
      'EXTERNAL_CONTRACT_ASSERTION_FAILED',
    );
  });

  it('rejects an external contract that is also listed as a deployment step', () => {
    const duplicatedEnvironment = EXTERNAL_ENVIRONMENT.replace(
      ':deploymentOrder [:shared/timelock',
      ':deploymentOrder [:shared/gov-token :shared/timelock',
    );
    try {
      resolveEdn({ environment: duplicatedEnvironment });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EXTERNAL_CONTRACT_IN_DEPLOYMENT_ORDER');
      return;
    }
    throw new Error('expected external/deployment duplicate rejection');
  });

  it('re-verifies external observations and exact pinned artifact identity from a V2 manifest', async () => {
    const externalContracts = await verifyExternalContracts(resolved.spec, bundle(), transport());
    const timelock = resolved.spec.contracts['shared/timelock']!;
    const timelockRuntime = bundle()
      .loadArtifact(timelock.artifactSource, timelock.artifact.package, timelock.artifact.version, timelock.artifactName)
      .artifact.deployedBytecode.toLowerCase() as Hex;
    const manifest: DeploymentManifestV2 = {
      type: 'protocol-deployment-manifest/v2',
      architectureSpecHash: resolved.specHash,
      executionSpecHash: '0xexecution',
      deploymentId: 'external-token-test',
      chain: { id: 31337, blockNumber: '49', blockHash: BASELINE_BLOCK },
      deployer: DEPLOYER,
      contracts: [{
        logicalId: 'shared/timelock',
        address: '0x0000000000000000000000000000000000000003',
        artifact: artifactIdentityOf(timelock),
        deploymentTx: (`0x${'b'.repeat(64)}`) as Hex,
        blockNumber: '49',
      }],
      externalContracts,
      bootstrapActions: [],
      finalAssertions: [],
    };
    const live = transport({
      blockHashes: { '49': BASELINE_BLOCK, '50': BASELINE_BLOCK },
      latest: { number: 50n, hash: BASELINE_BLOCK },
      code: (address) => address.toLowerCase() === TOKEN.toLowerCase() ? tokenRuntime : timelockRuntime,
    });
    const verified = await verifyLiveDeployment(manifest, live, resolved.spec, bundle());
    expect(verified.type).toBe('protocol-deployment-verification/v2');
    expect(verified.externalContracts).toMatchObject([{ logicalId: 'shared/gov-token', address: TOKEN, result: 'passed' }]);

    const tampered = { ...manifest, externalContracts: [{ ...externalContracts[0]!, artifact: { ...externalContracts[0]!.artifact, version: '0.0.0' } }] };
    await expectConfigCode(verifyLiveDeployment(tampered, live, resolved.spec, bundle()), 'EXTERNAL_CONTRACT_SPEC_MISMATCH');

    const wrongObservationBlock = { ...manifest, externalContracts: [{ ...externalContracts[0]!, observedAt: { ...externalContracts[0]!.observedAt, blockHash: (`0x${'9'.repeat(64)}`) as Hex } }] };
    await expectConfigCode(verifyLiveDeployment(wrongObservationBlock, live, resolved.spec, bundle()), 'EXTERNAL_CONTRACT_OBSERVATION_BLOCK_MISMATCH');

    const wrongObservationCode = { ...manifest, externalContracts: [{ ...externalContracts[0]!, observedRuntimeCodeKeccak256: `0x${'9'.repeat(64)}` }] };
    await expectConfigCode(verifyLiveDeployment(wrongObservationCode, live, resolved.spec, bundle()), 'EXTERNAL_CONTRACT_OBSERVATION_MISMATCH');

    const extraExternal = { ...externalContracts[0]!, logicalId: 'shared/another-token', address: '0x0000000000000000000000000000000000000004' as const };
    const wrongSet = { ...manifest, externalContracts: [...externalContracts, extraExternal] };
    await expectConfigCode(verifyLiveDeployment(wrongSet, live, resolved.spec, bundle()), 'EXTERNAL_CONTRACT_SET_MISMATCH');

    const legacyManifest: DeploymentManifestV1 = {
      type: 'protocol-deployment-manifest/v1',
      architectureSpecHash: manifest.architectureSpecHash,
      executionSpecHash: manifest.executionSpecHash,
      deploymentId: manifest.deploymentId,
      chain: manifest.chain,
      deployer: manifest.deployer,
      contracts: manifest.contracts,
      bootstrapActions: manifest.bootstrapActions,
      finalAssertions: manifest.finalAssertions,
    };
    await expectConfigCode(verifyLiveDeployment(legacyManifest, live, resolved.spec, bundle()), 'EXTERNAL_CONTRACT_MANIFEST_REQUIRED');
  });
});
