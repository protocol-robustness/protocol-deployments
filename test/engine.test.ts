import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { getContractAddress, keccak256, concat, toHex, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { BundleConsumer, FixtureBundleLocator } from '../src/artifacts/bundle';
import { RpcTransport } from '../src/runtime/transport';
import { PrivateKeySigner } from '../src/runtime/signer';
import { AnvilRuntime } from '../src/runtime/anvil';
import { deployContract } from '../src/deployment/engine';
import { canonicalJson } from '../src/canonical-json';
import type { ResolvedSpec, ResolvedContract } from '../src/canonical';
import {
  emptyRecord,
  saveRecord,
  loadRecord,
  artifactIdentityOf,
  type DeploymentRecord,
} from '../src/deployment/record';

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
let port = 18600;

function shaStr(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function bcHash(bc: string): string {
  return shaStr(bc.replace(/^0x/, '').toLowerCase());
}

describe('Phase C — deployment engine + deployment record', () => {
  let root: string;
  let bundle: BundleConsumer;
  let anvil: AnvilRuntime;
  let transport: RpcTransport;
  let signer: PrivateKeySigner;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-engine-'));
    const pkgDir = path.join(root, '@test', 'pkg');
    fs.mkdirSync(path.join(pkgDir, 'artifacts'), { recursive: true });

    const t = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'T.json'), 'utf8'));
    const fileBuf = Buffer.from(JSON.stringify(t), 'utf8');
    fs.writeFileSync(path.join(pkgDir, 'artifacts', 'T.json'), fileBuf);
    const manifest = {
      schemaVersion: 1,
      packageName: '@test/pkg',
      bundleVersion: '1.0.0',
      source: { repository: 'test/repo', commit: 'abc', commitSource: 'git', commitOverride: false, dirty: false },
      build: { artifactSource: 'forge', profile: 'default', compiler: { name: 'solc', version: '0.8.26' }, settings: { evmVersion: 'osaka', optimizerRuns: 200, viaIR: false } },
      artifacts: {
        T: {
          contractName: 'T',
          sourcePath: 'T.sol',
          scopeHint: 'sew',
          category: 'core',
          artifactFile: 'artifacts/T.json',
          abiSha256: shaStr(canonicalJson(t.abi)),
          creationBytecodeSha256: bcHash(t.bytecode),
          runtimeBytecodeSha256: bcHash(t.deployedBytecode),
          fileSha256: shaStr(fileBuf.toString()),
          hasLinkReferences: false,
          hasDeployedLinkReferences: false,
        },
      },
    };
    const bundleRoot = shaStr(canonicalJson(manifest));
    fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify({ ...manifest, bundleRoot }));

    bundle = new BundleConsumer(new FixtureBundleLocator(root));
    anvil = new AnvilRuntime({ port: port++, chainId: 31337, silent: true });
    await anvil.start();
    transport = anvil.rpc;
    signer = new PrivateKeySigner(DEV_KEY, anvil.url);
  });

  afterEach(async () => {
    await anvil.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeSpec(params: Array<{ name: string; value: string | number | boolean }>): ResolvedSpec {
    const contract: ResolvedContract = {
      logicalId: ':t',
      scope: 'sew',
      artifactSource: 'src',
      artifactName: 'T',
      artifact: {
        source: 'src',
        package: '@test/pkg',
        version: '1.0.0',
        sourceRepo: 'test/repo',
        sourceCommit: 'abc',
        artifactName: 'T',
        artifactPath: 'artifacts/T.json',
        fileSha256: '0'.repeat(64),
        abiSha256: '0'.repeat(64),
        creationBytecodeSha256: '0'.repeat(64),
        deployedBytecodeSha256: '0'.repeat(64),
        abi: JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'T.json'), 'utf8')).abi,
      },
      parameters: params.map((p) => ({
        name: p.name,
        value: p.value,
        mutability: 'immutable',
        overriddenByEnv: false,
        valueSource: 'architecture',
      })),
      relationships: [],
      deploymentOrder: 0,
      governedByGroups: [],
    };
    return {
      specVersion: 1,
      environment: 'test',
      chain: { logicalRole: 'local', chainId: 31337, source: 'test' },
      artifacts: {},
      contracts: { ':t': contract },
      governance: { governors: [], lanes: [], groups: [] },
      verification: { applications: [], profiles: [], verifierInstances: {} },
      deployment: { steps: [{ logicalId: ':t', order: 0, dependsOn: [] }], chainId: 31337 },
      intended: { chainId: 31337, contracts: {} },
    };
  }

  it('deploys a contract with constructor args and verifies runtime code', async () => {
    const spec = makeSpec([
      { name: '_v', value: 42 },
      { name: '_flag', value: true },
    ]);
    const res = await deployContract({ spec, logicalId: ':t', bundle, transport, signer });
    expect(res.mode).toBe('create');
    expect(res.address).toMatch(/^0x/);
    // runtime code verified (engine throws if mismatch); also confirm code present
    expect(await transport.getCode(res.address)).not.toBe('0x');
    // constructor arg applied: storage slot 0 == 42, slot 1 == 1 (true)
    const slot0 = (await transport.getStorageAt(res.address, 0n)) ?? '0x';
    expect(BigInt(slot0)).toBe(42n);
    const slot1 = (await transport.getStorageAt(res.address, 1n)) ?? '0x';
    expect(BigInt(slot1)).toBe(1n);
  }, 60000);

  it('rejects deployment when a constructor arg is unresolvable', async () => {
    const spec = makeSpec([{ name: '_v', value: 42 }]); // missing _flag
    try {
      await deployContract({ spec, logicalId: ':t', bundle, transport, signer });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe('UNRESOLVED_CONSTRUCTOR_ARG');
    }
  }, 60000);

  it('records a deployment fact preserving deployed parameter values', async () => {
    const spec = makeSpec([
      { name: '_v', value: 42 },
      { name: '_flag', value: true },
    ]);
    const res = await deployContract({ spec, logicalId: ':t', bundle, transport, signer });

    const record: DeploymentRecord = emptyRecord({ specHash: '0xdeadbeef', environment: 'test', chainId: 31337 });
    record.deployer = await signer.getAddress();
    const contract = spec.contracts[':t']!;
    record.contracts[':t'] = {
      kind: 'deployment',
      logicalId: ':t',
      artifact: artifactIdentityOf(contract),
      address: res.address,
      transactionHash: res.transactionHash,
      blockNumber: res.blockNumber.toString(),
      mode: res.mode,
      deployedParameters: res.deployedParameters,
    };
    record.status = 'complete';

    const recPath = path.join(root, 'deployments', 'test.deployment.json');
    saveRecord(recPath, record);
    const loaded = loadRecord(recPath)!;
    expect(loaded.status).toBe('complete');
    expect(loaded.contracts[':t']!.deployedParameters).toEqual({ _v: 42, _flag: true });
    // A later governance change is recorded separately and never overwrites the fact
    expect(loaded.contracts[':t']!.deployedParameters._v).toBe(42);
  }, 60000);

  it('derives a deterministic CREATE2 address matching a manual computation', () => {
    const factory: Address = '0x1234567890123456789012345678901234567890';
    const salt: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const initCode: Hex = '0x6000';
    const viaViem = getContractAddress({ from: factory, salt, bytecode: initCode, opcode: 'CREATE2' });
    // CREATE2 = keccak(0xff ++ factory ++ salt ++ keccak(initCode))[12:]
    const hash = keccak256(concat(['0xff', factory, salt, keccak256(initCode)] as Hex[]));
    const manual = getAddress(`0x${hash.slice(26)}`);
    expect(viaViem).toBe(manual);
  });
});
