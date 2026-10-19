import * as path from 'path';
import { decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';
import type { ResolvedSpec } from '../src/canonical';
import { loadConfig, loadEnvironment } from '../src/config/load';
import { inspectEffectiveVerifierClosure, replayEffectiveVerifierClosureFromManifest } from '../src/deployment/verifier-runtime-closure';
import { artifactIdentityOf } from '../src/deployment/record';
import { readSuccessorDeploymentPlan } from '../src/deployment/successor-plan';
import { resolve } from '../src/resolver';
import type { RpcTransport } from '../src/runtime/transport';

const root = path.resolve(__dirname, '..');
const profileDir = path.join(root, 'config/pro-rata-v2-entitlement');
const bundle = new BundleConsumer(new FixtureBundleLocator(path.join(root, 'fixtures/releases/0.4.1/packages')));
const config = loadConfig({ configDir: path.join(root, 'config'), profileDir });
const environment = loadEnvironment(path.join(root, 'config'), 'local', profileDir);
// Resolve the pinned architecture directly. The test does not claim that its
// placeholder canonical roots are approved or deployable.
const spec: ResolvedSpec = resolve({ config, environment, bundle }, { environmentSource: 'test' });
const plan = readSuccessorDeploymentPlan(path.join(profileDir, 'successor-fork.plan.v1.json'));
const closure = plan.verifierClosures[0]!;
const adapter = spec.contracts[closure.adapterLogicalId]!;
const verifier = spec.contracts[closure.verifierLogicalId]!;
const adapterAddress = `0x${'11'.repeat(20)}` as Address;
const verifierAddress = `0x${'22'.repeat(20)}` as Address;
const adapterTx = `0x${'33'.repeat(32)}` as Hex;
const verifierTx = `0x${'44'.repeat(32)}` as Hex;
const blockHash = `0x${'55'.repeat(32)}` as Hex;
const adapterArtifact = bundle.loadArtifact(adapter.artifactSource, adapter.artifact.package, adapter.artifact.version, adapter.artifactName).artifact;
const verifierArtifact = bundle.loadArtifact(verifier.artifactSource, verifier.artifact.package, verifier.artifact.version, verifier.artifactName).artifact;
const adapterCode = adapterArtifact.deployedBytecode as Hex;
const verifierCode = verifierArtifact.deployedBytecode as Hex;
const verifierAbi = adapterArtifact.abi as Abi;

function deploymentFact(contract: typeof adapter, address: Address, transactionHash: Hex) {
  return {
    logicalId: contract.logicalId,
    address,
    transactionHash,
    blockNumber: '7',
    blockHash,
    runtimeBytecodeSha256: artifactIdentityOf(contract).runtimeBytecodeSha256,
    artifact: artifactIdentityOf(contract),
  };
}

function mockTransport(options: { effectiveNow?: Address; adapterRuntimeNow?: Hex; verifierRuntimeNow?: Hex } = {}): RpcTransport {
  const receiptByHash: Record<string, { status: 'success'; contractAddress: Address; blockNumber: bigint }> = {
    [adapterTx]: { status: 'success', contractAddress: adapterAddress, blockNumber: 7n },
    [verifierTx]: { status: 'success', contractAddress: verifierAddress, blockNumber: 7n },
  };
  const metadata: Record<string, Hex> = {
    programVKey: closure.expectedProgramVKey as Hex,
    programElfSha256: closure.expectedProgramElfSha256 as Hex,
    statementSchemaVersion: closure.expectedStatementSchemaVersion as Hex,
    publicValuesSchema: closure.expectedPublicValuesSchema as Hex,
  };
  return {
    getChainId: async () => 31337,
    getTransactionReceipt: async (hash: Hex) => receiptByHash[hash] ?? null,
    getBlock: async () => ({ number: 7n, hash: blockHash }),
    getCode: async (address: Address, blockNumber?: bigint) => {
      if (address.toLowerCase() === adapterAddress.toLowerCase()) {
        return blockNumber === undefined ? (options.adapterRuntimeNow ?? adapterCode) : adapterCode;
      }
      if (address.toLowerCase() === verifierAddress.toLowerCase()) {
        return blockNumber === undefined ? (options.verifierRuntimeNow ?? verifierCode) : verifierCode;
      }
      return undefined;
    },
    call: async (request: { to: Address; data: Hex }, blockNumber?: bigint) => {
      const decoded = decodeFunctionData({ abi: verifierAbi, data: request.data });
      const functionName = String(decoded.functionName);
      const result = functionName === 'sp1Verifier'
        ? (blockNumber === undefined ? (options.effectiveNow ?? verifierAddress) : verifierAddress)
        : metadata[functionName];
      return encodeFunctionResult({ abi: verifierAbi, functionName: functionName as never, result } as never) as Hex;
    },
  } as unknown as RpcTransport;
}

async function inspect(transport: RpcTransport) {
  return inspectEffectiveVerifierClosure({
    closure,
    adapterFact: deploymentFact(adapter, adapterAddress, adapterTx),
    verifierFact: deploymentFact(verifier, verifierAddress, verifierTx),
    contracts: spec.contracts,
    bundle,
    transport,
    expectedChainId: 31337,
  });
}

describe('effective verifier runtime closure', () => {
  it('authenticates adapter metadata and the effective verifier at deployment and now', async () => {
    const evidence = await inspect(mockTransport());
    expect(evidence?.effectiveVerifier).toEqual({ atDeployment: verifierAddress, now: verifierAddress });
    expect(evidence?.metadata).toMatchObject({
      programVKey: { atDeployment: closure.expectedProgramVKey, now: closure.expectedProgramVKey },
      programElfSha256: { atDeployment: closure.expectedProgramElfSha256, now: closure.expectedProgramElfSha256 },
    });
    expect(evidence?.verifier.runtimeCodeKeccak256AtDeployment).toBe(evidence?.verifier.runtimeCodeKeccak256Now);
  });

  it('rejects a matching-metadata adapter that points to another effective verifier', async () => {
    const substitute = `0x${'66'.repeat(20)}` as Address;
    expect(await inspect(mockTransport({ effectiveNow: substitute }))).toBeUndefined();
  });

  it('rejects an adapter runtime substitution even when its metadata getters match', async () => {
    const substitutedRuntime = (`${adapterCode.slice(0, -2)}00`) as Hex;
    expect(await inspect(mockTransport({ adapterRuntimeNow: substitutedRuntime }))).toBeUndefined();
  });

  it('rejects a verifier runtime substitution even when its adapter metadata still matches', async () => {
    const substitutedRuntime = (`${verifierCode.slice(0, -2)}00`) as Hex;
    expect(await inspect(mockTransport({ verifierRuntimeNow: substitutedRuntime }))).toBeUndefined();
  });

  it('replays retained closure evidence from manifest deployments and pinned plan identity', async () => {
    const transport = mockTransport();
    const evidence = await inspect(transport);
    const manifest = {
      type: 'protocol-deployment-manifest/v1',
      architectureSpecHash: 'architecture', executionSpecHash: 'execution', deploymentId: 'local',
      chain: { id: 31337, blockNumber: '7', blockHash }, deployer: adapterAddress,
      contracts: [
        { logicalId: adapter.logicalId, address: adapterAddress, artifact: artifactIdentityOf(adapter), deploymentTx: adapterTx, blockNumber: '7' },
        { logicalId: verifier.logicalId, address: verifierAddress, artifact: artifactIdentityOf(verifier), deploymentTx: verifierTx, blockNumber: '7' },
      ], bootstrapActions: [],
      finalAssertions: [{ id: `verifier-runtime-closure:${adapter.logicalId}`, status: 'passed', verifiedAt: 'now', detail: JSON.stringify(evidence) }],
    } as never;
    const replayed = await replayEffectiveVerifierClosureFromManifest({
      closure, manifest, contracts: spec.contracts, bundle, transport, expectedChainId: 31337,
    });
    expect(replayed?.evidence).toEqual(evidence);
    expect(replayed?.assertion).toMatchObject({ id: `verifier-runtime-closure:${adapter.logicalId}`, result: 'passed' });
  });

  it('rejects retained closure evidence changed from independent deployment and RPC observations', async () => {
    const evidence = await inspect(mockTransport());
    const forged = { ...evidence!, effectiveVerifier: { atDeployment: verifierAddress, now: adapterAddress } };
    const manifest = {
      type: 'protocol-deployment-manifest/v1',
      architectureSpecHash: 'architecture', executionSpecHash: 'execution', deploymentId: 'local',
      chain: { id: 31337, blockNumber: '7', blockHash }, deployer: adapterAddress,
      contracts: [
        { logicalId: adapter.logicalId, address: adapterAddress, artifact: artifactIdentityOf(adapter), deploymentTx: adapterTx, blockNumber: '7' },
        { logicalId: verifier.logicalId, address: verifierAddress, artifact: artifactIdentityOf(verifier), deploymentTx: verifierTx, blockNumber: '7' },
      ], bootstrapActions: [],
      finalAssertions: [{ id: `verifier-runtime-closure:${adapter.logicalId}`, status: 'passed', verifiedAt: 'now', detail: JSON.stringify(forged) }],
    } as never;
    expect(await replayEffectiveVerifierClosureFromManifest({
      closure, manifest, contracts: spec.contracts, bundle, transport: mockTransport(), expectedChainId: 31337,
    })).toBeUndefined();
  });
});
