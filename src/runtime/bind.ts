import type { RawRuntime } from '../config/raw-types';
import { RpcTransport } from './transport';
import { PrivateKeySigner, DeterministicLocalSigner, type Signer } from './signer';
import { DevnetManager } from './devnet';
import { AnvilRuntime } from './anvil';
import { ConfigError } from '../errors';

export interface BoundRuntime {
  transport: RpcTransport;
  signer: Signer;
  rpcUrl: string;
  anvil?: AnvilRuntime;
}

function makeSigner(runtime: RawRuntime, rpcUrl: string): Signer {
  const s = runtime.signer;
  switch (s.type) {
    case 'deterministic-local':
      return new DeterministicLocalSigner(rpcUrl);
    case 'private-key-env': {
      if (!s.env) throw new ConfigError('SIGNER_ENV_UNSET', 'private-key-env signer requires :env');
      const key = process.env[s.env];
      if (!key) throw new ConfigError('SIGNER_KEY_UNSET', `Environment variable '${s.env}' is not set`);
      return new PrivateKeySigner(key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`), rpcUrl);
    }
    case 'unlocked': {
      throw new ConfigError(
        'UNLOCKED_SIGNER_UNSUPPORTED',
        'unlocked signer cannot sign locally; use a private-key signer for raw-transaction deployments',
      );
    }
    default:
      throw new ConfigError('SIGNER_UNSUPPORTED', `Unsupported signer type ${s.type}`);
  }
}

/**
 * Bind a runtime configuration to a concrete RPC transport + signer.
 *
 * For local anvil runtimes this starts (or reuses) the devnet. Secrets are
 * resolved from env-var names here and are never returned or serialized.
 */
export async function bindRuntime(
  runtime: RawRuntime,
  environmentName: string,
  configDir: string,
): Promise<BoundRuntime> {
  if (runtime.provider === 'external') {
    const rpcUrl = runtime.rpcUrlEnv ? process.env[runtime.rpcUrlEnv] : runtime.rpcUrl;
    if (!rpcUrl) {
      throw new ConfigError('RPC_URL_UNSET', `RPC URL for '${environmentName}' is not set (${runtime.rpcUrlEnv ?? 'no rpcUrlEnv'})`);
    }
    return { transport: new RpcTransport(rpcUrl), signer: makeSigner(runtime, rpcUrl), rpcUrl };
  }

  if (runtime.provider === 'anvil' || runtime.provider === 'anvil-fork') {
    const devnet = new DevnetManager({ configDir });
    const anvil = devnet.buildRuntime(environmentName);
    await anvil.start();
    return { transport: anvil.rpc, signer: makeSigner(runtime, anvil.url), rpcUrl: anvil.url, anvil };
  }

  throw new ConfigError('UNSUPPORTED_PROVIDER', `Unsupported runtime provider ${runtime.provider}`);
}
