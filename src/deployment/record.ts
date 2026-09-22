import * as fs from 'fs';
import * as path from 'path';
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
   * same parameter is recorded as a separate governance action and never
   * overwrites this original value.
   */
  deployedParameters: Record<string, string | number | boolean>;
}

export interface GovernanceAction {
  logicalId: string;
  parameter: string;
  fromValue: string | number | boolean;
  toValue: string | number | boolean;
  transactionHash: Hex;
  blockNumber: string;
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
  deployedAt?: string;
  contracts: Record<string, ContractDeploymentFact>;
  governanceActions: GovernanceAction[];
  /** Durable transition history for deploy steps; used for reconciliation/resume. */
  execution: Record<string, ExecutionStepRecord>;
  /** Bootstrap-only calls; later protocol governance is intentionally out of scope. */
  bootstrapActions: BootstrapActionRecord[];
  finalAssertions: FinalAssertionRecord[];
}

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
    governanceActions: [],
    execution: {},
    bootstrapActions: [],
    finalAssertions: [],
  };
}

export function loadRecord(recordPath: string): DeploymentRecord | null {
  if (!fs.existsSync(recordPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(recordPath, 'utf8')) as DeploymentRecord;
  } catch (e) {
    throw new ConfigError('RECORD_UNREADABLE', `Cannot read deployment record ${recordPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
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
