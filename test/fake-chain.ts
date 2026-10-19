import type { Address, Hex, Transaction } from 'viem';
import type { TransactionReceipt } from 'viem';
import { RpcTransport, type CallRequest, type TxFees } from '../src/runtime/transport';
import type { UnsignedTransaction } from '../src/runtime/signer';

export interface FakeChainOptions {
  chainId?: number;
  /** Hash reported for a specific block number, keyed by decimal block number. */
  blockHashes?: Record<string, Hex>;
  /** Block returned when `getBlock()` is called without a number (latest). */
  latest?: { number: bigint; hash: Hex };
  /** Runtime code per address. Defaults to a stable non-empty blob. */
  code?: (address: Address, blockNumber?: bigint) => Hex | undefined;
  /** `eth_call` response. */
  callResult?: Hex;
  /** `eth_getTransactionReceipt` response; `null` simulates a pending tx. */
  receipt?: TransactionReceipt | null;
  transaction?: Transaction | null;
  receiptFor?: (hash: Hex) => TransactionReceipt | null;
  transactionFor?: (hash: Hex) => Transaction | null;
  blockTransactionHashesFor?: (blockNumber: bigint) => Hex[];
  callFor?: (request: CallRequest, blockNumber?: bigint) => Hex;
  estimateGas?: bigint;
  /** EIP-1559 fees returned by `estimateFeesPerGas`. */
  fees?: TxFees;
  /** Deployer balance returned by `getBalance`. */
  balance?: bigint;
}

/**
 * In-memory `RpcTransport` for exercising fail-closed paths without a chain.
 *
 * Only the primitives the deployment pipeline actually calls are stubbed; the
 * inherited `RpcTransport` construction is inert because no method reaches the
 * network unless it is invoked.
 */
export class FakeTransport extends RpcTransport {
  constructor(private readonly opts: FakeChainOptions = {}) {
    super('http://127.0.0.1:0');
  }

  override async getChainId(): Promise<number> {
    return this.opts.chainId ?? 31337;
  }

  override async getBlock(blockNumber?: bigint): Promise<{ number: bigint; hash: Hex }> {
    if (blockNumber === undefined) {
      return this.opts.latest ?? { number: 12n, hash: ('0x' + 'e'.repeat(64)) as Hex };
    }
    const hash = this.opts.blockHashes?.[blockNumber.toString()];
    return { number: blockNumber, hash: hash ?? (('0x' + 'f'.repeat(64)) as Hex) };
  }

  override async getBlockTransactionHashes(blockNumber: bigint): Promise<Hex[]> {
    return this.opts.blockTransactionHashesFor?.(blockNumber) ?? [];
  }

  override async getCode(address: Address, blockNumber?: bigint): Promise<Hex | undefined> {
    if (this.opts.code) return this.opts.code(address, blockNumber);
    return ('0x' + '60'.repeat(64)) as Hex;
  }

  override async getTransactionCount(): Promise<number> {
    return 0;
  }

  override async estimateGas(_req: CallRequest): Promise<bigint> {
    return this.opts.estimateGas ?? 100000n;
  }

  override async estimateFeesPerGas(): Promise<TxFees> {
    return this.opts.fees ?? { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n };
  }

  override async getBalance(_address: Address): Promise<bigint> {
    return this.opts.balance ?? 0n;
  }

  override async sendRawTransaction(_raw: Hex): Promise<Hex> {
    return ('0x' + '1'.repeat(64)) as Hex;
  }

  override async getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    if (this.opts.receiptFor) return this.opts.receiptFor(hash);
    if (this.opts.receipt !== undefined) return this.opts.receipt;
    return { status: 'success', blockNumber: 5n } as unknown as TransactionReceipt;
  }

  override async getTransaction(hash: Hex): Promise<Transaction | null> {
    if (this.opts.transactionFor) return this.opts.transactionFor(hash);
    return this.opts.transaction ?? null;
  }

  override async call(_req: CallRequest, _blockNumber?: bigint): Promise<Hex> {
    if (this.opts.callFor) return this.opts.callFor(_req, _blockNumber);
    return this.opts.callResult ?? '0x';
  }
}

/** A 32-byte ABI word for a `uint256`/`uint8` return value. */
export const abiWord = (value: bigint | number | boolean): Hex =>
  ('0x' + BigInt(value).toString(16).padStart(64, '0')) as Hex;

/** A `Signer` that satisfies the interface without doing any crypto. */
export const fakeSigner = (address: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') => ({
  kind: 'fake',
  getAddress: async () => address,
  signTransaction: async () => ('0x' + 'ab'.repeat(64)) as Hex,
});

/** A `Signer` that records the unsigned transactions it is asked to sign. */
export const recordingSigner = (address: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266') => {
  const transactions: UnsignedTransaction[] = [];
  return {
    transactions,
    signer: {
      kind: 'recording',
      getAddress: async () => address,
      signTransaction: async (tx: UnsignedTransaction) => {
        transactions.push(tx);
        return ('0x' + 'ab'.repeat(64)) as Hex;
      },
    },
  };
};
