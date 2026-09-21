import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';

export interface CallRequest {
  to?: Address;
  from?: Address;
  data?: Hex;
  value?: bigint;
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

  async getCode(address: Address): Promise<Hex | undefined> {
    return this.publicClient.getCode({ address });
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

  async estimateGas(req: CallRequest): Promise<bigint> {
    return this.publicClient.estimateGas({ ...req, account: req.from });
  }

  /** Submit a raw (already-signed) transaction. Canonical submission path. */
  async sendRawTransaction(raw: Hex): Promise<Hex> {
    return this.walletClient.sendRawTransaction({ serializedTransaction: raw });
  }
}

export function createTransport(rpcUrl: string): RpcTransport {
  return new RpcTransport(rpcUrl);
}
