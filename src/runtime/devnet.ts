import * as path from 'path';
import { AnvilRuntime } from './anvil';
import { loadEnvironment, loadRuntime } from '../config/load';
import type { RawEnvironment, RawRuntime } from '../config/raw-types';
import { ConfigError } from '../errors';

const DEVNET_ROOT = path.resolve(process.cwd(), '.devnet', 'anvil');

export interface DevnetConfig {
  configDir: string;
  runtimeDir?: string;
  devnetRoot?: string;
}

export interface DevnetStatus {
  environment: string;
  running: boolean;
  url: string;
  stateFile: string;
}

/**
 * High-level local devnet lifecycle backed by Anvil state persistence.
 *
 * - `start`    spawn (or reuse) an Anvil chain, loading persisted state if any.
 * - `stop`     stop Anvil, dumping persisted state (--state).
 * - `reset`    stop and delete persisted state → next start is clean.
 * - `status`   report whether the chain is reachable.
 *
 * Persisted state lives under `.devnet/anvil/` (gitignored) — a runtime cache,
 * never the deployment ledger.
 */
export class DevnetManager {
  private readonly runtimeDir: string;
  private readonly devnetRoot: string;

  constructor(private readonly cfg: DevnetConfig) {
    this.runtimeDir = cfg.runtimeDir ?? path.resolve(cfg.configDir, '..', 'runtime');
    this.devnetRoot = cfg.devnetRoot ?? DEVNET_ROOT;
  }

  private stateDir(label: string): string {
    return path.join(this.devnetRoot, label);
  }

  private stateFile(label: string): string {
    return path.join(this.stateDir(label), 'state.json');
  }

  private pidFile(label: string): string {
    return path.join(this.stateDir(label), 'anvil.pid');
  }

  loadEnvAndRuntime(env: string): { environment: RawEnvironment; runtime: RawRuntime } {
    return {
      environment: loadEnvironment(this.cfg.configDir, env),
      runtime: loadRuntime(this.runtimeDir, env),
    };
  }

  buildRuntime(env: string): AnvilRuntime {
    const { environment, runtime } = this.loadEnvAndRuntime(env);
    const chainId = environment.chain.chainId;

    if (runtime.provider !== 'anvil' && runtime.provider !== 'anvil-fork') {
      throw new ConfigError(
        'NOT_LOCAL_RUNTIME',
        `Environment '${env}' uses provider '${runtime.provider}'; devnet lifecycle requires an anvil runtime`,
      );
    }

    let forkUrl: string | undefined;
    let forkBlock: number | undefined;
    if (runtime.provider === 'anvil-fork') {
      if (!runtime.sourceRpcEnv) {
        throw new ConfigError('FORK_SOURCE_UNSET', `anvil-fork runtime '${env}' requires :sourceRpcEnv`);
      }
      forkUrl = process.env[runtime.sourceRpcEnv];
      if (!forkUrl) {
        throw new ConfigError('FORK_SOURCE_UNSET', `Environment variable '${runtime.sourceRpcEnv}' is not set for fork runtime '${env}'`);
      }
      forkBlock = runtime.forkBlock;
    }

    return new AnvilRuntime({
      port: runtime.port ?? 8545,
      chainId,
      stateFile: this.stateFile(env),
      pidFile: this.pidFile(env),
      stateInterval: runtime.stateInterval,
      preserveHistoricalStates: runtime.preserveHistoricalStates,
      forkUrl,
      forkBlock,
    });
  }

  async start(env: string): Promise<AnvilRuntime> {
    const anvil = this.buildRuntime(env);
    await anvil.start();
    return anvil;
  }

  /** Returns true when a running devnet was actually stopped. */
  async stop(env: string): Promise<boolean> {
    const anvil = this.buildRuntime(env);
    return anvil.stop();
  }

  async reset(env: string): Promise<void> {
    const anvil = this.buildRuntime(env);
    await anvil.reset();
  }

  async status(env: string): Promise<DevnetStatus> {
    const anvil = this.buildRuntime(env);
    const running = await anvil.isRunning();
    return { environment: env, running, url: anvil.url, stateFile: this.stateFile(env) };
  }
}
