import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { bindRuntime } from '../src/runtime/bind';
import { DevnetManager } from '../src/runtime/devnet';
import { runtimeSchema, type RawRuntime } from '../src/config/raw-types';
import { ConfigError } from '../src/errors';

const CONFIG_DIR = path.resolve(__dirname, '..', 'config');

function runtime(input: Record<string, unknown>): RawRuntime {
  return runtimeSchema.parse(input);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

async function expectCodeAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

describe('runtime binding', () => {
  it('requires an RPC endpoint for an external provider', async () => {
    await expectCodeAsync(
      () => bindRuntime(runtime({ provider: 'external', rpcUrlEnv: 'MISSING_RPC_URL_VAR', signer: { type: 'deterministic-local' } }), 'base-sepolia', CONFIG_DIR),
      'RPC_URL_UNSET',
    );
    await expectCodeAsync(
      () => bindRuntime(runtime({ provider: 'external', signer: { type: 'deterministic-local' } }), 'base-sepolia', CONFIG_DIR),
      'RPC_URL_UNSET',
    );
  });

  it('binds an external provider with an inline rpcUrl without touching the network', async () => {
    const bound = await bindRuntime(
      runtime({ provider: 'external', rpcUrl: 'http://127.0.0.1:9', signer: { type: 'deterministic-local' } }),
      'external',
      CONFIG_DIR,
    );
    expect(bound.rpcUrl).toBe('http://127.0.0.1:9');
    expect(bound.anvil).toBeUndefined();
  });

  it('rejects signers that cannot produce a raw signature locally', async () => {
    await expectCodeAsync(
      () => bindRuntime(runtime({ provider: 'external', rpcUrl: 'http://127.0.0.1:9', signer: { type: 'unlocked' } }), 'external', CONFIG_DIR),
      'UNLOCKED_SIGNER_UNSUPPORTED',
    );
  });

  it('resolves private keys from the named environment variable only', async () => {
    delete process.env.PD_TEST_DEPLOYER_KEY;
    await expectCodeAsync(
      () => bindRuntime(runtime({ provider: 'external', rpcUrl: 'http://127.0.0.1:9', signer: { type: 'private-key-env', env: 'PD_TEST_DEPLOYER_KEY' } }), 'external', CONFIG_DIR),
      'SIGNER_KEY_UNSET',
    );
    await expectCodeAsync(
      () => bindRuntime(runtime({ provider: 'external', rpcUrl: 'http://127.0.0.1:9', signer: { type: 'private-key-env' } }), 'external', CONFIG_DIR),
      'SIGNER_ENV_UNSET',
    );
  });

  it('rejects an unsupported provider', async () => {
    const bogus = runtime({ provider: 'external', rpcUrl: 'http://127.0.0.1:9', signer: { type: 'deterministic-local' } });
    await expectCodeAsync(() => bindRuntime({ ...bogus, provider: 'geth' as never }, 'external', CONFIG_DIR), 'UNSUPPORTED_PROVIDER');
  });

  it('rejects an unsupported signer type', async () => {
    const bogus = runtime({ provider: 'external', rpcUrl: 'http://127.0.0.1:9', signer: { type: 'deterministic-local' } });
    await expectCodeAsync(
      () => bindRuntime({ ...bogus, signer: { type: 'ledger' } as never }, 'external', CONFIG_DIR),
      'SIGNER_UNSUPPORTED',
    );
  });
});

describe('devnet lifecycle guards', () => {
  it('refuses to run the devnet lifecycle against a non-local runtime', () => {
    const manager = new DevnetManager({ configDir: CONFIG_DIR });
    expectCode(() => manager.buildRuntime('base-sepolia'), 'NOT_LOCAL_RUNTIME');
  });

  it('builds a local anvil runtime without claiming ownership before start', () => {
    const manager = new DevnetManager({ configDir: CONFIG_DIR, devnetRoot: path.resolve(__dirname, '..', '.devnet', 'anvil') });
    const anvil = manager.buildRuntime('local');
    expect(anvil.ownedByProcess).toBe(false);
    expect(anvil.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
