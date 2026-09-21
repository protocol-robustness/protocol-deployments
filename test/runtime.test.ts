import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Address, Hex } from 'viem';
import { AnvilRuntime } from '../src/runtime/anvil';
import { RpcTransport } from '../src/runtime/transport';
import { PrivateKeySigner, DeterministicLocalSigner } from '../src/runtime/signer';

const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const running: AnvilRuntime[] = [];
let portCounter = 18560;
function nextPort(): number {
  return portCounter++;
}

describe('Phase B — Anvil runtime + transport + signer + persistence', () => {
  afterEach(async () => {
    for (const a of running) await a.stop().catch(() => {});
    running.length = 0;
  });

  it('transport reads chain id and signer is deterministic', async () => {
    const anvil = new AnvilRuntime({ port: nextPort(), chainId: 31337, silent: true });
    running.push(anvil);
    await anvil.start();
    expect(await anvil.rpc.getChainId()).toBe(31337);
    const signer = new DeterministicLocalSigner(anvil.url);
    expect(await signer.getAddress()).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('signs and submits a raw transfer, persists across restart, and reset clears it', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-anvil-'));
    const stateFile = path.join(stateDir, 'state.json');
    const recipient = '0x00000000000000000000000000000000000000AA';
    const port = nextPort();

    // --- first run: transfer 1 ETH, then stop (dumps state) ---
    let anvil = new AnvilRuntime({ port, chainId: 31337, stateFile, silent: true });
    running.push(anvil);
    await anvil.start();
    const signer = new PrivateKeySigner(DEV_KEY, anvil.url);
    const from = await signer.getAddress();
    const raw = await signer.signTransaction({
      chainId: await anvil.rpc.getChainId(),
      to: recipient,
      value: 1000000000000000000n,
      nonce: await anvil.rpc.getTransactionCount(from),
      gas: 21000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n,
    });
    const receipt = await waitReceipt(anvil.rpc, await anvil.rpc.sendRawTransaction(raw));
    expect(receipt?.status).toBe('success');
    expect(await anvil.rpc.getBalance(recipient)).toBe(1000000000000000000n);
    await anvil.stop();

    // --- restart with same persisted state: existing state preserved ---
    anvil = new AnvilRuntime({ port, chainId: 31337, stateFile, silent: true });
    running.push(anvil);
    await anvil.start();
    expect(await anvil.rpc.getBalance(recipient)).toBe(1000000000000000000n);
    await anvil.stop();

    // --- reset: clean chain ---
    anvil = new AnvilRuntime({ port, chainId: 31337, stateFile, silent: true });
    running.push(anvil);
    await anvil.reset();
    await anvil.start();
    expect(await anvil.rpc.getBalance(recipient)).toBe(0n);

    await anvil.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }, 60000);

  it('deploys minimal contract code and verifies runtime code exists', async () => {
    const anvil = new AnvilRuntime({ port: nextPort(), chainId: 31337, silent: true });
    running.push(anvil);
    await anvil.start();
    const signer = new PrivateKeySigner(DEV_KEY, anvil.url);
    const from = await signer.getAddress();
    const data = '0x6005600d60003960056000f36001600055' as Hex; // init returning 5-byte runtime
    const raw = await signer.signTransaction({
      chainId: await anvil.rpc.getChainId(),
      data,
      nonce: await anvil.rpc.getTransactionCount(from),
      gas: (await anvil.rpc.estimateGas({ from, data })) + 20000n,
      maxFeePerGas: 2000000000n,
      maxPriorityFeePerGas: 1000000000n,
    });
    const receipt = await waitReceipt(anvil.rpc, await anvil.rpc.sendRawTransaction(raw));
    expect(receipt?.status).toBe('success');
    const code = await anvil.rpc.getCode(receipt!.contractAddress! as Address);
    expect(code).toBeTruthy();
    expect(code).not.toBe('0x');
  }, 60000);
});

async function waitReceipt(transport: RpcTransport, hash: Hex) {
  for (let i = 0; i < 40; i++) {
    const r = await transport.getTransactionReceipt(hash);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}
