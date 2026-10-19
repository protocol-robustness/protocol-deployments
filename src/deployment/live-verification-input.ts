import * as fs from 'fs';
import { createHash } from 'crypto';
import { z } from 'zod';
import { canonicalJson } from '../canonical-json';
import type { ResolvedSpec } from '../canonical';
import { ConfigError } from '../errors';
import type { DeploymentManifest } from './manifest';
import { materializeExecutionSpec } from './execution-spec';

const resolvedSpecSchema = z.object({
  spec: z.object({
    specVersion: z.number(),
    environment: z.string().min(1),
    chain: z.object({ chainId: z.number().int().positive() }).passthrough(),
    contracts: z.record(z.string(), z.unknown()),
    deployment: z.object({
      steps: z.array(z.object({ logicalId: z.string().min(1) }).passthrough()).min(1),
      bootstrapAssertions: z.array(z.object({
        id: z.string().min(1), target: z.string().min(1), function: z.string().min(1),
        args: z.array(z.unknown()), expected: z.unknown(),
      }).passthrough()).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const resolvedFileSchema = z.object({
  specHash: z.string().min(1),
  environment: z.string().min(1),
  ...resolvedSpecSchema.shape,
}).passthrough();

const retainedResolvedSpecSchema = z.object({
  schema: z.literal('protocol-deployment-resolved-spec/v1'),
  specHash: z.string().min(1),
  executionSpecHash: z.string().min(1),
  environment: z.string().min(1),
  ...resolvedSpecSchema.shape,
}).passthrough();

export interface ResolvedVerificationInput {
  specHash: string;
  executionSpecHash?: string;
  environment: string;
  spec: ResolvedSpec;
}

export function retainedResolvedSpecEvidence(input: ResolvedVerificationInput): {
  schema: 'protocol-deployment-resolved-spec/v1';
  specHash: string;
  executionSpecHash: string;
  environment: string;
  spec: ResolvedSpec;
} {
  if (!input.executionSpecHash) throw new ConfigError('RESOLVED_MANIFEST_SPEC_MISMATCH', 'Retained resolved spec has no execution-spec identity');
  return { schema: 'protocol-deployment-resolved-spec/v1', specHash: input.specHash,
    executionSpecHash: input.executionSpecHash, environment: input.environment, spec: input.spec };
}

export function retainedResolvedSpecSha256(input: ResolvedVerificationInput): string {
  return createHash('sha256').update(canonicalJson(retainedResolvedSpecEvidence(input)), 'utf8').digest('hex');
}

export function assertResolvedSpecMatchesManifest(manifest: DeploymentManifest, resolved: ResolvedVerificationInput): void {
  if (resolved.specHash !== manifest.architectureSpecHash) {
    throw new ConfigError('RESOLVED_MANIFEST_SPEC_MISMATCH', 'Resolved architecture hash differs from the deployment manifest');
  }
  const expectedExecutionHash = materializeExecutionSpec(
    resolved.spec, resolved.specHash, manifest.deployer,
    (resolved.spec.externalAddresses ?? {}) as Record<string, `0x${string}`>,
  ).executionSpecHash;
  if (expectedExecutionHash !== manifest.executionSpecHash ||
      (resolved.executionSpecHash !== undefined && resolved.executionSpecHash !== expectedExecutionHash)) {
    throw new ConfigError('RESOLVED_MANIFEST_SPEC_MISMATCH', 'Resolved execution bindings differ from the deployment manifest');
  }
}

/** Read the resolved specification as an untrusted qualification input. */
export function readResolvedVerificationSpec(file: string): ResolvedSpec {
  return readResolvedVerificationInput(file).spec;
}

export function readResolvedVerificationInput(file: string): ResolvedVerificationInput {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    throw new ConfigError('CONFIG_SCHEMA', `Cannot parse resolved specification '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = z.union([resolvedFileSchema, retainedResolvedSpecSchema]).safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError('CONFIG_SCHEMA', `Resolved specification '${file}' failed validation`, { details: { issues: parsed.error.issues } });
  }
  return {
    specHash: parsed.data.specHash,
    ...(typeof parsed.data.executionSpecHash === 'string' ? { executionSpecHash: parsed.data.executionSpecHash } : {}),
    environment: parsed.data.environment,
    spec: parsed.data.spec as unknown as ResolvedSpec,
  };
}
