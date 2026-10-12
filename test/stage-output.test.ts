import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSuccessorDeploymentPlan } from '../src/deployment/successor-plan';
import { createStageOutputReceipt, readStageOutputReceipt, resolveVerifiedStageOutput, stageOutputValueRoot, verifyStageOutputReceipt, verifyStageOutputReceiptGraph, writeStageOutputReceipt, type StageOutputReceiptV1 } from '../src/deployment/stage-output';

const plan = readSuccessorDeploymentPlan('config/pro-rata-v2-entitlement/successor-fork.plan.v1.json');
const artifactIdentities = { 'prf-evm-deployables/0.4.0': `0x${'a1'.repeat(32)}` };
const base = {
  plan,
  environment: 'local-fixture',
  chainId: 31337,
  sourceRevision: 'revision:fixture-test',
  artifactIdentities,
};

function initialRootsReceipt() {
  return createStageOutputReceipt({
    ...base,
    stageId: 'derive-genesis-roots',
    predecessorInputs: {},
    outputs: {
      protocolGenesisRoot: `sha256:${'11'.repeat(32)}`,
      authorityStateRoot: `sha256:${'22'.repeat(32)}`,
      emptyRegistryRoot: `sha256:${'33'.repeat(32)}`,
      initialConfigurationRoot: `sha256:${'44'.repeat(32)}`,
    },
    observations: [{ kind: 'canonical-derivation', authority: 'test-only-unapproved' }],
  });
}

describe('stage-output receipts', () => {
  it('rejects undeclared stages, malformed receipts, and mismatched input/output sets', async () => {
    expect(() => createStageOutputReceipt({ ...base, stageId: 'missing-stage', predecessorInputs: {}, outputs: {} }))
      .toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_UNKNOWN_STAGE' }));
    expect(() => createStageOutputReceipt({ ...base, stageId: 'derive-genesis-roots', predecessorInputs: {}, outputs: {} }))
      .toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_OUTPUT_SET' }));
    expect(() => createStageOutputReceipt({
      ...base, stageId: 'deploy-authority-and-verifier', predecessorInputs: {}, outputs: {},
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_INPUT_SET' }));
    await expect(verifyStageOutputReceipt({
      receipt: {}, ...base, stageId: 'derive-genesis-roots', predecessorReceipts: {}, verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_RECEIPT_INVALID' });
    expect(() => readStageOutputReceipt(path.join(os.tmpdir(), 'missing-stage-output-receipt.json')))
      .toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_RECEIPT_UNREADABLE' }));
  });

  it('rejects predecessor plan, output-name, and missing-output substitutions', () => {
    const parent = initialRootsReceipt();
    const childInputs = {
      protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
      authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
    };
    expect(() => createStageOutputReceipt({
      ...base, stageId: 'deploy-authority-and-verifier',
      predecessorInputs: { ...childInputs, protocolGenesisRoot: { ...childInputs.protocolGenesisRoot, outputName: 'authorityStateRoot' } },
      outputs: {
        authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5,
      },
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_PARENT_BINDING' }));
    const parentMissing = {
      ...parent,
      outputs: Object.fromEntries(Object.entries(parent.outputs).filter(([name]) => name !== 'protocolGenesisRoot')),
    } as unknown as StageOutputReceiptV1;
    expect(() => createStageOutputReceipt({
      ...base, stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { ...childInputs.protocolGenesisRoot, receipt: parentMissing },
        authorityStateRoot: childInputs.authorityStateRoot,
      },
      outputs: { authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5 },
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_PARENT_MISSING' }));
    expect(() => createStageOutputReceipt({
      ...base, stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { ...childInputs.protocolGenesisRoot, receipt: { ...parent, planHash: `0x${'99'.repeat(32)}` } },
        authorityStateRoot: childInputs.authorityStateRoot,
      },
      outputs: { authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5 },
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_PARENT_PLAN' }));
  });

  it('binds a downstream stage to exact predecessor output and receipt roots', async () => {
    const parent = initialRootsReceipt();
    const stage = createStageOutputReceipt({
      ...base,
      stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: { address: `0x${'55'.repeat(20)}`, runtimeCodeHash: `0x${'66'.repeat(32)}` },
        registry: { address: `0x${'56'.repeat(20)}`, runtimeCodeHash: `0x${'67'.repeat(32)}` },
        sp1Verifier: { address: `0x${'57'.repeat(20)}`, runtimeCodeHash: `0x${'68'.repeat(32)}` },
        successorAdapter: { address: `0x${'58'.repeat(20)}`, runtimeCodeHash: `0x${'69'.repeat(32)}` },
        verifierId: `0x${'70'.repeat(32)}`,
      },
      observations: [{ kind: 'deployment-receipt', tx: `0x${'77'.repeat(32)}` }],
    });
    const verifiedParent = await verifyStageOutputReceipt({
      receipt: parent, ...base, stageId: parent.stageId, predecessorReceipts: {}, verifyOutput: async () => true,
    });
    const verifiedChild = await verifyStageOutputReceipt({
      receipt: stage,
      ...base,
      stageId: stage.stageId,
      predecessorReceipts: { [parent.stageId]: verifiedParent },
      verifyOutput: async (_name, value) => value !== undefined,
    });
    expect(verifiedChild.inputs.protocolGenesisRoot!.receiptRoot).toBe(parent.receiptRoot);
    expect(verifiedChild.inputs.authorityStateRoot!.outputRoot).toBe(parent.outputs.authorityStateRoot!.outputRoot);
  });

  it('verifies receipt graphs in dependency order and resolves only declared verified outputs', async () => {
    const parent = initialRootsReceipt();
    const child = createStageOutputReceipt({
      ...base,
      stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: { address: `0x${'55'.repeat(20)}`, runtimeCodeHash: `0x${'66'.repeat(32)}` },
        registry: { address: `0x${'56'.repeat(20)}`, runtimeCodeHash: `0x${'67'.repeat(32)}` },
        sp1Verifier: { address: `0x${'57'.repeat(20)}`, runtimeCodeHash: `0x${'68'.repeat(32)}` },
        successorAdapter: { address: `0x${'58'.repeat(20)}`, runtimeCodeHash: `0x${'69'.repeat(32)}` },
        verifierId: `0x${'70'.repeat(32)}`,
      },
    });
    const verified = await verifyStageOutputReceiptGraph({
      receipts: { [parent.stageId]: parent, [child.stageId]: child },
      ...base,
      verifyOutput: async (_stage, _name, value) => value !== undefined,
    });
    const resolved = resolveVerifiedStageOutput({
      plan,
      verifiedReceipts: verified,
      consumerStageId: 'deploy-authority-and-verifier',
      inputName: 'protocolGenesisRoot',
    });
    expect(resolved).toMatchObject({
      value: parent.outputs.protocolGenesisRoot!.value,
      producerStageId: parent.stageId,
      outputName: 'protocolGenesisRoot',
      receiptRoot: parent.receiptRoot,
      outputRoot: parent.outputs.protocolGenesisRoot!.outputRoot,
    });
    expect(() => resolveVerifiedStageOutput({
      plan, verifiedReceipts: verified, consumerStageId: child.stageId, inputName: 'unlisted',
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_UNDECLARED_INPUT' }));
    expect(() => resolveVerifiedStageOutput({
      plan, verifiedReceipts: {}, consumerStageId: child.stageId, inputName: 'protocolGenesisRoot',
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_PARENT_UNVERIFIED' }));
  });

  it('does not verify a downstream receipt when its predecessor receipt is absent', async () => {
    const parent = initialRootsReceipt();
    const child = createStageOutputReceipt({
      ...base,
      stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5,
      },
    });
    await expect(verifyStageOutputReceiptGraph({
      receipts: { [child.stageId]: child },
      ...base,
      verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_PREREQUISITE_UNVERIFIED' });
  });

  it('rejects tampered, substituted and wrong-chain outputs even if the caller supplies the receipt', async () => {
    const parent = initialRootsReceipt();
    const receipt = createStageOutputReceipt({
      ...base,
      stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: { address: `0x${'55'.repeat(20)}`, runtimeCodeHash: `0x${'66'.repeat(32)}` },
        registry: { address: `0x${'56'.repeat(20)}`, runtimeCodeHash: `0x${'67'.repeat(32)}` },
        sp1Verifier: { address: `0x${'57'.repeat(20)}`, runtimeCodeHash: `0x${'68'.repeat(32)}` },
        successorAdapter: { address: `0x${'58'.repeat(20)}`, runtimeCodeHash: `0x${'69'.repeat(32)}` },
        verifierId: `0x${'70'.repeat(32)}`,
      },
    });
    const verifiedParent = await verifyStageOutputReceipt({
      receipt: parent, ...base, stageId: parent.stageId, predecessorReceipts: {}, verifyOutput: async () => true,
    });
    await expect(verifyStageOutputReceipt({
      receipt: { ...receipt, outputs: { ...receipt.outputs, authorityAdapter: { value: { address: `0x${'88'.repeat(20)}` }, outputRoot: receipt.outputs.authorityAdapter!.outputRoot } } },
      ...base, stageId: receipt.stageId, predecessorReceipts: { [parent.stageId]: verifiedParent }, verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_RECEIPT_ROOT_MISMATCH' });
    await expect(verifyStageOutputReceipt({
      receipt, ...base, chainId: 1, stageId: receipt.stageId,
      predecessorReceipts: { [parent.stageId]: verifiedParent }, verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_CHAIN_MISMATCH' });
    await expect(verifyStageOutputReceipt({
      receipt, ...base, stageId: receipt.stageId,
      predecessorReceipts: { [parent.stageId]: { ...verifiedParent, receiptRoot: `0x${'99'.repeat(32)}` } }, verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_PARENT_MISMATCH' });
  });

  it('requires independent output verification and deterministic output commitments', async () => {
    const parent = initialRootsReceipt();
    expect(parent.outputs.protocolGenesisRoot!.outputRoot).toBe(stageOutputValueRoot(parent.outputs.protocolGenesisRoot!.value));
    await expect(verifyStageOutputReceipt({
      receipt: parent, ...base, stageId: parent.stageId, predecessorReceipts: {}, verifyOutput: async () => false,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_LIVE_VERIFICATION_FAILED' });
  });

  it('persists stage receipts immutably and reuses exact evidence on resume', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-stage-receipt-'));
    const receipt = initialRootsReceipt();
    const file = writeStageOutputReceipt(directory, receipt);
    expect(readStageOutputReceipt(file)).toEqual(receipt);
    expect(writeStageOutputReceipt(directory, receipt)).toBe(file);
    expect(() => writeStageOutputReceipt(directory, {
      ...receipt,
      outputs: { ...receipt.outputs, protocolGenesisRoot: { value: 'changed', outputRoot: receipt.outputs.protocolGenesisRoot!.outputRoot } },
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_RECEIPT_EXISTS_CONFLICT' }));
  });

  it('rejects stage identity, provenance, and recomputed-receipt value tampering', async () => {
    const parent = initialRootsReceipt();
    const validReceipt = await verifyStageOutputReceipt({
      receipt: parent, ...base, stageId: parent.stageId, predecessorReceipts: {}, verifyOutput: async () => true,
    });
    await expect(verifyStageOutputReceipt({
      receipt: validReceipt, ...base, stageId: 'deploy-authority-and-verifier', predecessorReceipts: {}, verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_IDENTITY_MISMATCH' });
    await expect(verifyStageOutputReceipt({
      receipt: validReceipt, ...base, sourceRevision: 'revision:other', stageId: parent.stageId, predecessorReceipts: {}, verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_PROVENANCE_MISMATCH' });
    const { receiptRoot: _ignored, ...body } = validReceipt;
    const changedValueBody = {
      ...body,
      outputs: { ...body.outputs, protocolGenesisRoot: { ...body.outputs.protocolGenesisRoot!, value: 'sha256:changed' } },
    };
    const { keccak256Hex } = await import('../src/artifacts/hash');
    const { canonicalJson } = await import('../src/canonical-json');
    const forgedButConsistentReceipt = {
      ...changedValueBody,
      receiptRoot: `0x${keccak256Hex(`prf-deployment-stage-output:v1:${canonicalJson(changedValueBody)}`)}`,
    };
    await expect(verifyStageOutputReceipt({
      receipt: forgedButConsistentReceipt, ...base, stageId: parent.stageId, predecessorReceipts: {}, verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_VALUE_ROOT_MISMATCH' });
  });
});
