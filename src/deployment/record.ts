import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { Address, Hex } from 'viem';
import { ConfigError } from '../errors';
import type { ResolvedContract } from '../canonical';

export interface ArtifactIdentity {
  source: string;
  package: string;
  version: string;
  artifactName: string;
  abiSha256: string;
  creationBytecodeSha256: string;
  runtimeBytecodeSha256: string;
}

export interface ContractDeploymentFact {
  kind: 'deployment';
  logicalId: string;
  artifact: ArtifactIdentity;
  address: Address;
  transactionHash: Hex;
  blockNumber: string;
  mode: 'create' | 'create2';
  /**
   * The resolved parameter values that were applied at deployment time.
   * This is an immutable deployment fact: a later governance change to the
   * same parameter is a separate observation recorded elsewhere and never
   * overwrites this original value.
   */
  deployedParameters: Record<string, string | number | boolean>;
}

export interface ExecutionStepRecord {
  status: 'planned' | 'submitted' | 'confirmed' | 'verified' | 'failed';
  transactionHash?: Hex;
  blockNumber?: string;
  address?: Address;
  error?: string;
}

export interface BootstrapActionRecord {
  id: string;
  status: 'planned' | 'submitted' | 'confirmed' | 'verified' | 'failed';
  transactionHash?: Hex;
  blockNumber?: string;
  verification?: string;
}

export interface FinalAssertionRecord {
  id: string;
  status: 'passed' | 'failed';
  verifiedAt: string;
  detail?: string;
}

export interface DeploymentRecord {
  schemaVersion: 1;
  /** Stable run identity; records are durable working evidence, not a registry. */
  deploymentId?: string;
  specHash: string;
  executionSpecHash?: string;
  environment: string;
  chainId: number;
  status: 'complete' | 'partial';
  deployer?: Address;
  blockNumber?: string;
  /** Identity of `blockNumber`, recorded so a manifest can be re-checked later. */
  blockHash?: Hex;
  deployedAt?: string;
  contracts: Record<string, ContractDeploymentFact>;
  /** Durable transition history for deploy steps; used for reconciliation/resume. */
  execution: Record<string, ExecutionStepRecord>;
  /** Bootstrap-only calls; later protocol governance is intentionally out of scope. */
  bootstrapActions: BootstrapActionRecord[];
  finalAssertions: FinalAssertionRecord[];
}

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const uintString = z.string().regex(/^\d+$/);

const artifactSchema = z.object({
  source: z.string(),
  package: z.string(),
  version: z.string(),
  artifactName: z.string(),
  abiSha256: z.string(),
  creationBytecodeSha256: z.string(),
  runtimeBytecodeSha256: z.string(),
});

const contractFactSchema = z.object({
  kind: z.literal('deployment'),
  logicalId: z.string(),
  artifact: artifactSchema,
  address,
  transactionHash: hex,
  blockNumber: uintString,
  mode: z.enum(['create', 'create2']),
  deployedParameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const executionStepSchema = z.object({
  status: z.enum(['planned', 'submitted', 'confirmed', 'verified', 'failed']),
  transactionHash: hex.optional(),
  blockNumber: uintString.optional(),
  address: address.optional(),
  error: z.string().optional(),
});

const bootstrapActionSchema = z.object({
  id: z.string(),
  status: z.enum(['planned', 'submitted', 'confirmed', 'verified', 'failed']),
  transactionHash: hex.optional(),
  blockNumber: uintString.optional(),
  verification: z.string().optional(),
});

const finalAssertionSchema = z.object({
  id: z.string(),
  status: z.enum(['passed', 'failed']),
  verifiedAt: z.string(),
  detail: z.string().optional(),
});

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  deploymentId: z.string().optional(),
  specHash: z.string(),
  executionSpecHash: z.string().optional(),
  environment: z.string(),
  chainId: z.number(),
  status: z.enum(['complete', 'partial']),
  deployer: address.optional(),
  blockNumber: uintString.optional(),
  blockHash: hex.optional(),
  deployedAt: z.string().optional(),
  contracts: z.record(z.string(), contractFactSchema),
  execution: z.record(z.string(), executionStepSchema),
  bootstrapActions: z.array(bootstrapActionSchema),
  finalAssertions: z.array(finalAssertionSchema),
});

export function artifactIdentityOf(contract: ResolvedContract): ArtifactIdentity {
  return {
    source: contract.artifactSource,
    package: contract.artifact.package,
    version: contract.artifact.version,
    artifactName: contract.artifactName,
    abiSha256: contract.artifact.abiSha256,
    creationBytecodeSha256: contract.artifact.creationBytecodeSha256,
    runtimeBytecodeSha256: contract.artifact.deployedBytecodeSha256,
  };
}

export function emptyRecord(opts: { specHash: string; environment: string; chainId: number }): DeploymentRecord {
  return {
    schemaVersion: 1,
    specHash: opts.specHash,
    environment: opts.environment,
    chainId: opts.chainId,
    status: 'partial',
    contracts: {},
    execution: {},
    bootstrapActions: [],
    finalAssertions: [],
  };
}

/**
 * Load a durable deployment record. The record drives `--resume`, so a
 * truncated or hand-edited file must fail closed instead of being cast.
 */
export function loadRecord(recordPath: string): DeploymentRecord | null {
  if (!fs.existsSync(recordPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (e) {
    throw new ConfigError('RECORD_UNREADABLE', `Cannot read deployment record ${recordPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError('RECORD_UNREADABLE', `Deployment record ${recordPath} failed schema validation`, { path: recordPath, details: { issues: parsed.error.issues } });
  }
  return parsed.data as DeploymentRecord;
}

export function saveRecord(recordPath: string, record: DeploymentRecord): void {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const tmp = `${recordPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(tmp, recordPath);
}

export function recordPathFor(deploymentsDir: string, environment: string): string {
  return path.join(deploymentsDir, `${environment}.deployment.json`);
}
