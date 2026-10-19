import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSuccessorDeploymentPlan } from '../src/deployment/successor-plan';
import { createStageOutputReceipt, readStageOutputReceipt, readStageOutputReceiptDirectory, resolveVerifiedStageOutput, stageOutputValueRoot, stageOutputValuesForPlan, verifyStageOutputReceipt, verifyStageOutputReceiptGraph, writeStageOutputReceipt, type StageOutputReceiptV1 } from '../src/deployment/stage-output';
import { resolveDeployment } from '../src/resolve-deployment';

const plan = readSuccessorDeploymentPlan('config/pro-rata-v2-entitlement/successor-fork.plan.v1.json');
const artifactIdentities = { 'prf-evm-deployables/0.4.1': `0x${'a1'.repeat(32)}` };
const base = {
  plan,
  environment: 'local-fixture',
  chainId: 31337,
  sourceRevision: 'revision:fixture-test',
  artifactIdentities,
};

function deploymentFact(logicalId: string, address: string) {
  return {
    logicalId,
    address,
    transactionHash: `0x${'77'.repeat(32)}`,
    blockNumber: '7',
    blockHash: `0x${'88'.repeat(32)}`,
    runtimeBytecodeSha256: '99'.repeat(32),
    artifact: {
      source: 'prf/deployables', package: '@protocol-robustness/prf-evm-deployables', version: '0.4.1',
      artifactName: 'SP1VerifierGroth16', abiSha256: 'aa'.repeat(32),
      creationBytecodeSha256: 'bb'.repeat(32), runtimeBytecodeSha256: '99'.repeat(32),
    },
  };
}

function initialRootsReceipt(receiptPlan = plan) {
  return createStageOutputReceipt({
    ...base, plan: receiptPlan,
    stageId: 'derive-genesis-roots',
    predecessorInputs: {},
    outputs: {
      protocolGenesisRoot: `sha256:${'11'.repeat(32)}`,
      authorityStateRoot: `sha256:${'22'.repeat(32)}`,
      emptyRegistryRoot: `sha256:${'33'.repeat(32)}`,
    },
    observations: [{ kind: 'canonical-derivation', authority: 'test-only-unapproved' }],
  });
}

describe('stage-output receipts', () => {
  it('rejects missing receipt directories and duplicate stage receipt files', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-stage-directory-'));
    try {
      expect(() => readStageOutputReceiptDirectory(path.join(directory, 'missing')))
        .toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_DIRECTORY_MISSING' }));
      const receipt = initialRootsReceipt();
      writeStageOutputReceipt(directory, receipt);
      fs.writeFileSync(path.join(directory, 'duplicate.stage-output.v1.json'), `${JSON.stringify(receipt)}\n`);
      expect(() => readStageOutputReceiptDirectory(directory))
        .toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_DUPLICATE_STAGE' }));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

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
        authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5, authorityTransitionValidator: 6,
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
      outputs: { authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5, authorityTransitionValidator: 6 },
    })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_PARENT_MISSING' }));
    expect(() => createStageOutputReceipt({
      ...base, stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { ...childInputs.protocolGenesisRoot, receipt: { ...parent, planHash: `0x${'99'.repeat(32)}` } },
        authorityStateRoot: childInputs.authorityStateRoot,
      },
      outputs: { authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5, authorityTransitionValidator: 6 },
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
        authorityTransitionValidator: { address: `0x${'59'.repeat(20)}`, runtimeCodeHash: `0x${'6a'.repeat(32)}` },
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
        authorityTransitionValidator: { address: `0x${'59'.repeat(20)}`, runtimeCodeHash: `0x${'6a'.repeat(32)}` },
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

  it('extracts a selected address only from its exact plan/stage/output receipt binding', () => {
    const sourcePlan = structuredClone(plan);
    sourcePlan.contracts['prf/source-bound-entitlement-verifier-adapter-v1'] = {
      kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier', output: 'successorAdapter',
    };
    sourcePlan.stages.find((stage) => stage.id === 'deploy-authority-and-verifier')!.dependsOn.push('deploy-local-token');
    const parent = initialRootsReceipt(sourcePlan);
    const child = createStageOutputReceipt({
      ...base,
      plan: sourcePlan,
      stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: 'unconsumed',
        registry: 'unconsumed',
        sp1Verifier: 'unconsumed',
        successorAdapter: deploymentFact('prf/source-bound-entitlement-verifier-adapter-v1', `0x${'58'.repeat(20)}`),
        verifierId: 'unconsumed',
        authorityTransitionValidator: 'unconsumed',
      },
    });
    expect(stageOutputValuesForPlan(sourcePlan, { [child.stageId]: child })).toEqual({
      'prf/source-bound-entitlement-verifier-adapter-v1': child.outputs.successorAdapter!.value,
    });
    const changedReceipt = { ...child, planHash: `0x${'99'.repeat(32)}` };
    expect(() => stageOutputValuesForPlan(sourcePlan, { [child.stageId]: changedReceipt })).toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_IDENTITY_MISMATCH' }));
    const malformedFact = createStageOutputReceipt({
      ...base,
      plan: sourcePlan,
      stageId: child.stageId,
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: 'unconsumed', registry: 'unconsumed', sp1Verifier: 'unconsumed',
        successorAdapter: { logicalId: 'prf/other-contract', address: `0x${'58'.repeat(20)}` },
        verifierId: 'unconsumed',
        authorityTransitionValidator: 'unconsumed',
      },
    });
    expect(() => stageOutputValuesForPlan(sourcePlan, { [malformedFact.stageId]: malformedFact }))
      .toThrow(expect.objectContaining({ code: 'STAGE_OUTPUT_CONTRACT_VALUE_INVALID' }));
  });

  it('feeds receipt-bound stage outputs into the actual selected-plan resolver without deploying them', () => {
    const root = path.resolve(__dirname, '..');
    const sourcePlan = structuredClone(plan);
    sourcePlan.contracts = {
      'prf/local-token': structuredClone(plan.contracts['prf/local-token']!),
      'prf/sp1-verifier-groth16': { kind: 'stage-output', unit: 'prf-assurance', stage: 'deploy-authority-and-verifier', output: 'sp1Verifier' },
    };
    sourcePlan.authorizedConfigurationActions = [];
    const parent = initialRootsReceipt(sourcePlan);
    const child = createStageOutputReceipt({
      ...base,
      plan: sourcePlan,
      stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: 'unused', registry: 'unused',
        successorAdapter: 'unused',
        sp1Verifier: deploymentFact('prf/sp1-verifier-groth16', `0x${'58'.repeat(20)}`),
        verifierId: 'unused',
        authorityTransitionValidator: 'unused',
      },
    });
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prf-plan-stage-output-'));
    try {
      const planFile = path.join(temporary, 'plan.json');
      const receiptsDir = path.join(temporary, 'receipts');
      fs.writeFileSync(planFile, JSON.stringify(sourcePlan));
      writeStageOutputReceipt(receiptsDir, parent);
      writeStageOutputReceipt(receiptsDir, child);
      const resolved = resolveDeployment({
        configDir: path.join(root, 'config'),
        environment: 'local',
        fixtureRoot: path.join(root, 'fixtures/releases/0.4.2/packages'),
        profileDir: path.join(root, 'config/pro-rata-v2-entitlement'),
        preferFixtures: true,
        deploymentPlanFile: planFile,
        stageOutputReceiptsDir: receiptsDir,
      });
      expect(resolved.spec.deployment.steps.map((step) => step.logicalId)).not.toContain('prf/sp1-verifier-groth16');
      expect(resolved.spec.externalContracts?.['prf/sp1-verifier-groth16']?.address).toBe(`0x${'58'.repeat(20)}`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
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
        authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5, authorityTransitionValidator: 6,
      },
    });
    await expect(verifyStageOutputReceiptGraph({
      receipts: { [child.stageId]: child },
      ...base,
      verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_PREREQUISITE_UNVERIFIED' });
  });

  it('rejects a structurally valid but independently unverified predecessor object', async () => {
    const parent = initialRootsReceipt();
    const child = createStageOutputReceipt({
      ...base,
      stageId: 'deploy-authority-and-verifier',
      predecessorInputs: {
        protocolGenesisRoot: { stageId: parent.stageId, outputName: 'protocolGenesisRoot', receipt: parent },
        authorityStateRoot: { stageId: parent.stageId, outputName: 'authorityStateRoot', receipt: parent },
      },
      outputs: {
        authorityAdapter: 1, registry: 2, sp1Verifier: 3, successorAdapter: 4, verifierId: 5, authorityTransitionValidator: 6,
      },
    });
    await expect(verifyStageOutputReceipt({
      receipt: child,
      ...base,
      stageId: child.stageId,
      predecessorReceipts: { [parent.stageId]: parent as never },
      verifyOutput: async () => true,
    })).rejects.toMatchObject({ code: 'STAGE_OUTPUT_PARENT_MISMATCH' });
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
        authorityTransitionValidator: { address: `0x${'59'.repeat(20)}`, runtimeCodeHash: `0x${'6a'.repeat(32)}` },
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
