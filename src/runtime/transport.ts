import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transaction,
} from 'viem';
import { ConfigError } from '../errors';

export interface CallRequest {
  to?: Address;
  from?: Address;
  data?: Hex;
  value?: bigint;
}

/** EIP-1559 fee parameters used for an unsigned transaction. */
export interface TxFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Thin ordinary JSON-RPC transport for a single EVM chain.
 *
 * Wraps viem clients for the mechanical primitives but exposes only the small,
 * explicit surface the deployment engine needs. It is provider-agnostic (Anvil,
 * hosted RPC, fork, geth, etc.) and contains NO orchestration logic.
 *
 * `eth_sendRawTransaction` is the canonical submission path — the node never
 * needs to hold a signing key. `eth_sendTransaction` is intentionally absent.
 */
export class RpcTransport {
  private readonly publicClient: PublicClient;
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.publicClient = createPublicClient({ transport: http(rpcUrl) });
    this.walletClient = createWalletClient({ transport: http(rpcUrl) });
  }

  async getChainId(): Promise<number> {
    return this.publicClient.getChainId();
  }

  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async getBlock(blockNumber?: bigint): Promise<{ number: bigint; hash: Hex }> {
    const block = await this.publicClient.getBlock(blockNumber === undefined ? {} : { blockNumber });
    if (block.number === null || block.hash === null) throw new Error('RPC returned an incomplete block identity');
    return { number: block.number, hash: block.hash };
  }

  async getBlockTransactionHashes(blockNumber: bigint): Promise<Hex[]> {
    const block = await this.publicClient.getBlock({ blockNumber, includeTransactions: true });
    return block.transactions.map((transaction) => typeof transaction === 'string' ? transaction : transaction.hash);
  }

  async getCode(address: Address, blockNumber?: bigint): Promise<Hex | undefined> {
    return this.publicClient.getCode(blockNumber === undefined ? { address } : { address, blockNumber });
  }

  async getTransactionCount(address: Address): Promise<number> {
    return this.publicClient.getTransactionCount({ address });
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address });
  }

  async getStorageAt(address: Address, slot: bigint | number | Hex): Promise<Hex | undefined> {
    return this.publicClient.getStorageAt({ address, slot: toHex(slot) });
  }

  async getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    try {
      return await this.publicClient.getTransactionReceipt({ hash });
    } catch {
      return null;
    }
  }

  async getTransaction(hash: Hex): Promise<Transaction | null> {
    try {
      return await this.publicClient.getTransaction({ hash });
    } catch {
      return null;
    }
  }

  async call(req: CallRequest, blockNumber?: bigint): Promise<Hex> {
    return this.publicClient.call({ ...req, account: req.from, blockNumber }).then((result) => result.data ?? '0x');
  }

  async estimateGas(req: CallRequest): Promise<bigint> {
    return this.publicClient.estimateGas({ ...req, account: req.from });
  }

  /**
   * Read live EIP-1559 fee parameters from the chain. Falls back to the legacy
   * `gasPrice` (with zero priority fee) on chains that do not expose 1559 fees,
   * so a deployment is never underpriced by a hardcoded constant.
   */
  async estimateFeesPerGas(): Promise<TxFees> {
    const fees = await this.publicClient.estimateFeesPerGas();
    if ('maxFeePerGas' in fees && fees.maxFeePerGas !== undefined && fees.maxFeePerGas !== null) {
      return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n };
    }
    const gasPrice = 'gasPrice' in fees ? fees.gasPrice : undefined;
    if (gasPrice === undefined || gasPrice === null) {
      throw new ConfigError('FEE_ESTIMATE_UNAVAILABLE', 'RPC did not return EIP-1559 fees or a legacy gas price');
    }
    return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n };
  }

  /** Submit a raw (already-signed) transaction. Canonical submission path. */
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    return this.walletClient.sendRawTransaction({ serializedTransaction: raw });
  }
}

export function createTransport(rpcUrl: string): RpcTransport {
  return new RpcTransport(rpcUrl);
}
