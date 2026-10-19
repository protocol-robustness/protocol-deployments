import { describe, expect, it } from 'vitest';
import type { ResolvedSpec } from '../src/canonical';
import { ConfigError } from '../src/errors';
import { materializeExecutionSpec } from '../src/deployment/execution-spec';
import type { DeploymentManifestV1 } from '../src/deployment/manifest';
import {
  assertResolvedSpecMatchesManifest,
  retainedResolvedSpecSha256,
  type ResolvedVerificationInput,
} from '../src/deployment/live-verification-input';
import { resolveEdn } from './helpers';

const DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const;
const resolvedBase = resolveEdn();
const spec = resolvedBase.spec;
const executionSpecHash = materializeExecutionSpec(spec, resolvedBase.specHash, DEPLOYER).executionSpecHash;
const input: ResolvedVerificationInput = {
  specHash: resolvedBase.specHash,
  executionSpecHash,
  environment: 'test',
  spec,
};
const manifest = {
  type: 'protocol-deployment-manifest/v1',
  architectureSpecHash: resolvedBase.specHash,
  executionSpecHash,
  deploymentId: 'test',
  chain: { id: 31337, blockNumber: '1', blockHash: `0x${'1'.repeat(64)}` },
  deployer: DEPLOYER,
  contracts: [],
  bootstrapActions: [],
  finalAssertions: [],
} as unknown as DeploymentManifestV1;

describe('resolved verification input binding', () => {
  it('accepts a resolved spec whose architecture and execution identities match the manifest', () => {
    expect(() => assertResolvedSpecMatchesManifest(manifest, input)).not.toThrow();
  });

  it('rejects a resolved spec with a different execution identity', () => {
    expect(() => assertResolvedSpecMatchesManifest(manifest, { ...input, executionSpecHash: `0x${'0'.repeat(64)}` }))
      .toThrowError(expect.objectContaining({ code: 'RESOLVED_MANIFEST_SPEC_MISMATCH' }));
  });

  it('commits post-transition spec bindings in a stable evidence digest', () => {
    expect(retainedResolvedSpecSha256(input)).toBe(retainedResolvedSpecSha256({ ...input }));
    const changed = { ...input, spec: { ...spec, chain: { ...spec.chain, chainId: 31338 } } as ResolvedSpec };
    expect(retainedResolvedSpecSha256(changed)).not.toBe(retainedResolvedSpecSha256(input));
  });

  it('requires an execution identity to retain a resolved spec digest', () => {
    expect(() => retainedResolvedSpecSha256({ ...input, executionSpecHash: undefined }))
      .toThrowError(expect.objectContaining({ code: 'RESOLVED_MANIFEST_SPEC_MISMATCH' } satisfies Partial<ConfigError>));
  });
});
