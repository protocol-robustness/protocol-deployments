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

export interface DeploymentRecord {
  schemaVersion: 1;
  specHash: string;
  environment: string;
  chainId: number;
  status: 'complete' | 'partial';
  deployer?: Address;
  blockNumber?: string;
  deployedAt?: string;
  contracts: Record<string, ContractDeploymentFact>;
  governanceActions: GovernanceAction[];
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
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
}

export function recordPathFor(deploymentsDir: string, environment: string): string {
  return path.join(deploymentsDir, `${environment}.deployment.json`);
}
