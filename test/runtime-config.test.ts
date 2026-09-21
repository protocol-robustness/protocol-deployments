import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEnvironment, loadRuntime } from '../src/config/load';
import { ConfigError } from '../src/errors';

describe('runtime / environment separation', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-runtime-'));
    fs.mkdirSync(path.join(root, 'config', 'environments'), { recursive: true });
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (rel: string, content: string) => fs.writeFileSync(path.join(root, rel), content);

  it('loads an anvil runtime (separate from environment)', () => {
    write('config/environments/local.edn', `{:schemaVersion 1 :environment :local
       :chain {:logicalRole :local :chainId 31337 :kind :local}
       :deploymentOrder []}`);
    write('runtime/local.edn', `{:schemaVersion 1 :provider :anvil
       :rpcUrl "http://127.0.0.1:8545"
       :signer {:type :deterministic-local}}`);
    const env = loadEnvironment(path.join(root, 'config'), 'local');
    expect(env.chain.chainId).toBe(31337);
    expect('network' in env.chain).toBe(false);
    const rt = loadRuntime(path.join(root, 'config'), 'local');
    expect(rt.provider).toBe('anvil');
    expect(rt.signer.type).toBe('deterministic-local');
  });

  it('loads an external runtime with env-var secret references (never inline)', () => {
    write('config/environments/base-sepolia.edn', `{:schemaVersion 1 :environment :base-sepolia
       :chain {:logicalRole :testnet :chainId 84532 :kind :testnet}
       :deploymentOrder []}`);
    write('runtime/base-sepolia.edn', `{:schemaVersion 1 :provider :external
       :rpcUrlEnv "BASE_SEPOLIA_RPC_URL"
       :signer {:type :private-key-env :env "BASE_SEPOLIA_DEPLOYER_KEY"}}`);
    const rt = loadRuntime(path.join(root, 'config'), 'base-sepolia');
    expect(rt.provider).toBe('external');
    expect(rt.rpcUrlEnv).toBe('BASE_SEPOLIA_RPC_URL');
    // the raw config contains env-var NAMES, not secret values
    const raw = fs.readFileSync(path.join(root, 'runtime', 'base-sepolia.edn'), 'utf8');
    expect(raw).not.toMatch(/0x[0-9a-f]{64}/);
  });

  it('rejects a legacy :chain/:network key with an explicit migration error', () => {
    write('config/environments/legacy.edn', `{:schemaVersion 1 :environment :legacy
       :chain {:logicalRole :local :chainId 31337 :network "hardhat"}
       :deploymentOrder []}`);
    try {
      loadEnvironment(path.join(root, 'config'), 'legacy');
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('ENV_SCHEMA_MIGRATION');
    }
  });

  it('fails clearly when a runtime file is missing', () => {
    try {
      loadRuntime(path.join(root, 'config'), 'missing');
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).code).toBe('EDN_FILE_NOT_FOUND');
    }
  });

  it('represents a fork as a runtime while chain identity stays the environment chain id', () => {
    write('config/environments/base-fork.edn', `{:schemaVersion 1 :environment :base-fork
       :chain {:logicalRole :settlement :chainId 8453 :kind :mainnet}
       :deploymentOrder []}`);
    write('runtime/base-fork.edn', `{:schemaVersion 1 :provider :anvil-fork
       :sourceRpcEnv "BASE_MAINNET_RPC_URL" :forkBlock 38200000
       :signer {:type :deterministic-local}}`);
    const env = loadEnvironment(path.join(root, 'config'), 'base-fork');
    const rt = loadRuntime(path.join(root, 'config'), 'base-fork');
    // chain identity is the deployment config (Base), not the runtime origin
    expect(env.chain.chainId).toBe(8453);
    expect(env.chain.logicalRole).toBe('settlement');
    // runtime origin is an anvil fork
    expect(rt.provider).toBe('anvil-fork');
    expect(rt.forkBlock).toBe(38200000);
    expect(rt.sourceRpcEnv).toBe('BASE_MAINNET_RPC_URL');
  });
});
