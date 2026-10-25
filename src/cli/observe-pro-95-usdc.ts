import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

const baseRpcUrl = 'https://sepolia.base.org';
const publicNodeUrl = 'https://base-sepolia-rpc.publicnode.com';
const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const payer = '0xdd82cceb1d515f2e4fb0432fb5d53138813945d4';
const selectors = { implementation: '0x5c60da1b', name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', paused: '0x5c975abb', balanceOf: '0x70a08231' };

const providers = [{ id: 'base-public-rpc', url: baseRpcUrl }, { id: 'publicnode', url: publicNodeUrl }];
type JsonRpcBlock = { number: string; hash: string; parentHash: string; timestamp: string };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'PRO-95-read-only-preflight' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  const result = await response.json() as { result?: T; error?: unknown };
  if (result.error) throw new Error(`RPC ${method} error: ${JSON.stringify(result.error)}`);
  if (result.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return result.result;
}

function decodeString(data: string): string {
  const hex = data.slice(2);
  const offset = Number(BigInt(`0x${hex.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${hex.slice(offset, offset + 64)}`));
  const bytes = hex.slice(offset + 64, offset + 64 + length * 2);
  return new TextDecoder().decode(hexToBytes(bytes));
}

async function observe(id: string, url: string, blockNumber: bigint) {
  const tag = `0x${blockNumber.toString(16)}`;
  const block = await rpc<JsonRpcBlock | null>(url, 'eth_getBlockByNumber', [tag, false]);
  if (!block) throw new Error(`${id}: no block at ${blockNumber}`);
  const proxyCode = await rpc<string>(url, 'eth_getCode', [token, tag]);
  if (!proxyCode || proxyCode === '0x') throw new Error(`${id}: USDC proxy code is empty at block ${blockNumber}`);
  const call = async (data: string) => rpc<string>(url, 'eth_call', [{ to: token, data }, tag]);
  const implementationResult = await call(selectors.implementation);
  const implementation = `0x${implementationResult.slice(-40)}`;
  const implementationCode = await rpc<string>(url, 'eth_getCode', [implementation, tag]);
  if (!implementationCode || implementationCode === '0x') throw new Error(`${id}: implementation code is empty at block ${blockNumber}`);
  const [name, symbol, decimals, paused, payerUsdc, payerEth] = await Promise.all([
    call(selectors.name), call(selectors.symbol), call(selectors.decimals), call(selectors.paused),
    call(`${selectors.balanceOf}${payer.slice(2).padStart(64, '0')}`),
    rpc<string>(url, 'eth_getBalance', [payer, tag]),
  ]);
  return {
    provider: id,
    block: { number: BigInt(block.number).toString(), hash: block.hash, parentHash: block.parentHash, timestamp: BigInt(block.timestamp).toString() },
    token: {
      address: token,
      proxyCodeBytes: (proxyCode.length - 2) / 2,
      proxyCodeKeccak256: `0x${bytesToHex(keccak_256(hexToBytes(proxyCode.slice(2))))}`,
      implementation,
      implementationCodeBytes: (implementationCode.length - 2) / 2,
      implementationCodeKeccak256: `0x${bytesToHex(keccak_256(hexToBytes(implementationCode.slice(2))))}`,
      name: decodeString(name),
      symbol: decodeString(symbol),
      decimals: Number(BigInt(decimals)),
      paused: BigInt(paused) !== 0n,
    },
    payer: { address: payer, usdcBalanceBaseUnits: BigInt(payerUsdc).toString(), ethBalanceWei: BigInt(payerEth).toString() },
  };
}

async function main() {
  const heads = await Promise.all(providers.map(async ({ id, url }) => ({
    provider: id,
    chainId: Number(BigInt(await rpc<string>(url, 'eth_chainId', []))),
    head: BigInt(await rpc<string>(url, 'eth_blockNumber', [])),
  })));
  if (heads.some(({ chainId: id }) => id !== 84532)) throw new Error('An RPC endpoint reported a chain ID other than Base Sepolia (84532)');
  const minHead = heads.reduce((min, current) => current.head < min ? current.head : min, heads[0]!.head);
  if (minHead < 5n) throw new Error('Provider head is too low to select the observation block');
  const blockNumber = minHead - 4n;
  const observations = await Promise.all(providers.map(({ id, url }) => observe(id, url, blockNumber)));
  const [first, second] = observations as [typeof observations[number], typeof observations[number]];
  const { provider: _firstProvider, ...firstValues } = first;
  const { provider: _secondProvider, ...secondValues } = second;
  const observationsAgree = JSON.stringify(firstValues) === JSON.stringify(secondValues);

  const artifact = {
    schema: 'protocol-deployments.pro-95-usdc-read-only-observation.v1',
    classification: 'unqualified-read-only-observation',
    capturedAt: new Date().toISOString(),
    network: { name: 'Base Sepolia', chainId: 84532 },
    providerHeads: heads.map(({ provider, chainId: id, head }) => ({
      provider,
      endpoint: providers.find((entry) => entry.id === provider)!.url,
      chainId: id,
      head: head.toString(),
    })),
    blockSelection: 'minimum observed provider head minus four; a query convenience, not a finality or freshness policy',
    observationBlock: blockNumber.toString(),
    observationsAgree,
    observations,
    limitations: [
      'Matching provider observations do not establish provider independence or an independently selected trust anchor.',
      'No Base or Ethereum consensus finality is established.',
      'Issuer source authentication and source-to-runtime equivalence are not established by this observation.',
      'ERC-20 transfer behavior has not been tested.',
      'Balances are observations at this block only and do not establish funding availability for a later run.',
      'This artifact does not approve a deployment, transaction plan, signing, broadcast, or use of funds.',
      ...(!observationsAgree ? ['The providers returned different block or contract observations; resolve the discrepancy before relying on this artifact.'] : []),
    ],
  };
  const output = process.argv[2];
  if (output) {
    const path = resolve(output);
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`Wrote ${path}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  }
  if (!observationsAgree) {
    process.stderr.write('Provider observations disagree; inspect the retained artifact and do not rely on it.\n');
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
