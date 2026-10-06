import { createWalletClient, http, type Address, type Chain, type Hex } from 'viem';
import { signTransaction } from 'viem/actions';
import { privateKeyToAccount } from 'viem/accounts';

export interface UnsignedTransaction {
  chainId: number;
  to?: Address;
  value?: bigint;
  data?: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * A signer authorizes transactions locally. The RPC node never needs to hold
 * the key (canonical path is eth_sendRawTransaction). This keeps signing out of
 * Anvil/Hardhat/Foundry/provider, making the engine runtime-independent.
 */
export interface Signer {
  readonly kind: string;
  getAddress(): Promise<Address>;
  signTransaction(tx: UnsignedTransaction): Promise<Hex>;
}

function chainFromId(chainId: number, rpcUrl: string): Chain {
  return {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

function signWithAccount(
  account: ReturnType<typeof privateKeyToAccount>,
  rpcUrl: string,
  tx: UnsignedTransaction,
): Promise<Hex> {
  const client = createWalletClient({ transport: http(rpcUrl) });
  return signTransaction(client, {
    account,
    chain: chainFromId(tx.chainId, rpcUrl),
    to: tx.to,
    value: tx.value,
    data: tx.data,
    nonce: tx.nonce,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  });
}

/** Canonical signer for real deployments: a local private key. */
export class PrivateKeySigner implements Signer {
  readonly kind: string = 'private-key';
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(privateKey: Hex, private readonly rpcUrl: string) {
    this.account = privateKeyToAccount(privateKey);
  }

  async getAddress(): Promise<Address> {
    return this.account.address;
  }

  signTransaction(tx: UnsignedTransaction): Promise<Hex> {
    return signWithAccount(this.account, this.rpcUrl, tx);
  }
}

/** Dev-only signer using a well-known deterministic key (never in production). */
export class DeterministicLocalSigner extends PrivateKeySigner {
  override readonly kind = 'deterministic-local';
  constructor(rpcUrl: string) {
    // Standard Anvil/Hardhat dev account #0 — DEV ONLY.
    super('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', rpcUrl);
  }
}
