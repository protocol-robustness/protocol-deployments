import { describe, expect, it, vi } from 'vitest';
import type { ContractDeploymentFact } from '../src/deployment/record';
import { deploymentFactFromRecord } from '../src/deployment/verifier-runtime-closure';
import type { RpcTransport } from '../src/runtime/transport';

const fact: ContractDeploymentFact = {
  kind: 'deployment',
  logicalId: 'prf/verifier',
  artifact: {
    source: 'fixture', package: 'prf', version: '1.0.0', artifactName: 'Verifier',
    abiSha256: 'a'.repeat(64), creationBytecodeSha256: 'b'.repeat(64), runtimeBytecodeSha256: 'c'.repeat(64),
  },
  address: `0x${'11'.repeat(20)}`,
  transactionHash: `0x${'22'.repeat(32)}`,
  blockNumber: '17',
  mode: 'create',
  deployedParameters: {},
};

function transport(receipt: unknown): RpcTransport {
  return {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    getBlock: vi.fn().mockResolvedValue({ number: 17n, hash: `0x${'33'.repeat(32)}` }),
  } as unknown as RpcTransport;
}

describe('deploymentFactFromRecord', () => {
  it('pins a fresh deployment fact to its successful receipt and block identity', async () => {
    const rpc = transport({
      status: 'success', contractAddress: fact.address, blockNumber: 17n,
    });
    await expect(deploymentFactFromRecord({ fact, transport: rpc })).resolves.toEqual({
      logicalId: fact.logicalId,
      address: fact.address,
      transactionHash: fact.transactionHash,
      blockNumber: '17',
      blockHash: `0x${'33'.repeat(32)}`,
      runtimeBytecodeSha256: fact.artifact.runtimeBytecodeSha256,
      artifact: fact.artifact,
    });
  });

  it.each([
    ['missing receipt', null],
    ['reverted receipt', { status: 'reverted', contractAddress: fact.address, blockNumber: 17n }],
    ['wrong contract', { status: 'success', contractAddress: `0x${'44'.repeat(20)}`, blockNumber: 17n }],
    ['wrong block', { status: 'success', contractAddress: fact.address, blockNumber: 18n }],
  ])('rejects %s', async (_label, receipt) => {
    await expect(deploymentFactFromRecord({ fact, transport: transport(receipt) })).resolves.toBeUndefined();
  });
});
