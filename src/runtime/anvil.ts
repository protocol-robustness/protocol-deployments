import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RpcTransport } from './transport';

export interface AnvilOptions {
  port: number;
  chainId?: number;
  /** Persisted-state file (anvil --state): loaded if present, dumped on exit. */
  stateFile?: string;
  /** Fork configuration (optional). */
  forkUrl?: string;
  forkBlock?: number;
  silent?: boolean;
}

/**
 * Local Anvil lifecycle backed by Anvil's JSON state persistence.
 *
 * The persisted Anvil state is a runtime cache under `.devnet/`, NOT the
 * deployment ledger and never under `deployments/`. A clean devnet is always
 * reproducible from the declarative spec + fixtures + deployment machinery.
 *
 * The engine interacts only via ordinary JSON-RPC (`RpcTransport`); Anvil is
 * simply the process hosting that endpoint.
 */
export class AnvilRuntime {
  private proc: ChildProcess | null = null;
  readonly rpcUrl: string;
  private readonly transport: RpcTransport;

  constructor(private readonly opts: AnvilOptions) {
    this.rpcUrl = `http://127.0.0.1:${opts.port}`;
    this.transport = new RpcTransport(this.rpcUrl);
  }

  get url(): string {
    return this.rpcUrl;
  }

  get rpc(): RpcTransport {
    return this.transport;
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.transport.getChainId();
      return true;
    } catch {
      return false;
    }
  }

  async start(timeoutMs = 20000): Promise<void> {
    if (this.proc) {
      if (await this.isRunning()) return; // our own process already serving
      this.proc = null; // stale handle; respawn below
    }
    const args = ['--port', String(this.opts.port), '--host', '127.0.0.1'];
    if (this.opts.chainId !== undefined) args.push('--chain-id', String(this.opts.chainId));
    if (this.opts.forkUrl) {
      args.push('--fork-url', this.opts.forkUrl);
      if (this.opts.forkBlock !== undefined) args.push('--fork-block-number', String(this.opts.forkBlock));
    }
    if (this.opts.stateFile) {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      args.push('--state', this.opts.stateFile);
    }
    args.push('--silent');

    const proc = spawn('anvil', args, {
      stdio: this.opts.silent === false ? ['ignore', 'inherit', 'inherit'] : 'ignore',
    });
    this.proc = proc;
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
    });

    // Wait for readiness, but fail loudly if the process exits early (e.g. a
    // foreign process already owns the port) rather than silently using it.
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!this.proc) {
        throw new Error(
          `Anvil exited before becoming ready on ${this.rpcUrl} — is another process using port ${this.opts.port}?`,
        );
      }
      try {
        await this.transport.getChainId();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error(`Anvil did not become ready on ${this.rpcUrl} within ${timeoutMs}ms`);
  }

  async stop(timeoutMs = 15000): Promise<void> {
    const p = this.proc;
    if (!p) return;
    p.kill('SIGTERM'); // anvil dumps persisted state on exit (--state)
    const start = Date.now();
    // Wait until the process is gone AND the port is no longer responding,
    // so a subsequent start() on the same port spawns a genuinely fresh node.
    while (Date.now() - start < timeoutMs) {
      if (!this.proc || !(await this.isRunning())) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    // Allow the OS to release the listening socket before reuse.
    await new Promise((r) => setTimeout(r, 200));
  }

  /** Remove persisted state so the next start is a clean chain. */
  resetState(): void {
    if (this.opts.stateFile && fs.existsSync(this.opts.stateFile)) {
      fs.rmSync(this.opts.stateFile, { force: true });
    }
  }

  /** Reset = stop (dump if running) then delete persisted state. */
  async reset(): Promise<void> {
    await this.stop();
    this.resetState();
  }
}
