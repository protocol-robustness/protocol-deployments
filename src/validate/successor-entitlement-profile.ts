import { z } from 'zod';
import { keccak256, stringToHex } from 'viem';
import { BundleConsumer, FixtureBundleLocator } from '../artifacts/bundle';
import { readEdnFile } from '../config/edn';

const hash32 = z.string().regex(/^(0x)?[0-9a-f]{64}$/i);
const schema = z.object({
  schema: z.literal('protocol-deployments.successor-entitlement-testnet-profile.v1'),
  profileId: z.literal('prf/pro-rata-v2-entitlement/base-sepolia'),
  environment: z.object({ id: z.literal('base-sepolia'), chainId: z.literal(84532), kind: z.literal('testnet') }).passthrough(),
  readiness: z.object({
    status: z.enum(['blocked', 'ready']),
    deploymentEnabled: z.boolean(),
    admissionEnabled: z.boolean(),
    unresolvedDependencies: z.array(z.string()),
  }).passthrough(),
  artifactBundle: z.object({
    package: z.string(), version: z.string(), bundleRoot: hash32,
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/), sourceDirty: z.boolean(),
  }).passthrough(),
  proofProgram: z.object({
    programId: z.literal('source-bound-entitlement-sp1-program.v1'),
    proofSystem: z.literal('groth16-bn254'),
    vkey: hash32,
    elfSha256: hash32,
    statementSchema: z.literal('prf/onchain-shortfall-allocation-binding.v1'),
    statementSchemaWord: hash32,
    publicValuesSchema: z.literal('prf/source-bound-entitlement-public-values.v1'),
    publicValuesSchemaWord: hash32,
    publicValuesLengthBytes: z.literal(288),
  }).passthrough(),
  contracts: z.array(z.object({ type: z.string(), artifact: z.string(), runtimeBytecodeSha256: hash32 }).passthrough()).min(1),
  authorityMatrix: z.record(z.string(), z.unknown()),
}).passthrough();

export interface SuccessorEntitlementProfileCheck {
  profileIntegrity: 'valid' | 'invalid';
  deploymentStatus: 'blocked' | 'ready';
  unresolvedDependencies: string[];
  errors: string[];
}

const requiredContractTypes = [
  'SP1VerifierGroth16',
  'PrfSourceBoundEntitlementVerifierAdapterV1',
  'PrfVerifierRegistry',
  'PrfLocalAuthorityAdapter',
  'PrfChainInstanceGenesis',
  'SewConfigurationExecutor',
  'PrfStatementAdmission',
  'SourceBoundProRataControllerV2',
  'ProductionProRataAllocatorV2',
  'OnchainShortfallReserveV2',
  'SourceBoundProRataEntitlementAssuranceV1',
  'SourceBoundProRataEntitlementRatificationControllerV1',
  'CommittedImmutableEntitlementRepresentationV1',
];

function hasUnresolvedAuthority(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnresolvedAuthority);
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.status === 'unresolved' || record.address === null || record.addresses === null) return true;
  return Object.values(record).some(hasUnresolvedAuthority);
}

function containsPlaceholderWord(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPlaceholderWord);
  if (typeof value === 'string') return /^0x([0-5])\1{63}$/i.test(value);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(containsPlaceholderWord);
  return false;
}

/**
 * Validate the non-deployable Base readiness profile against the exact pinned
 * artifact bundle. This is an integrity/readiness check, not deployment or
 * verifier admission. A blocked profile is a valid result and can never be
 * passed to the generic deployment resolver.
 */
export function validateSuccessorEntitlementProfile(
  rawProfile: unknown,
  bundle: ReturnType<BundleConsumer['loadManifest']>,
  localArchitecture: unknown,
  localEnvironment: unknown,
): SuccessorEntitlementProfileCheck {
  const parsed = schema.safeParse(rawProfile);
  if (!parsed.success) {
    return { profileIntegrity: 'invalid', deploymentStatus: 'blocked', unresolvedDependencies: [], errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const profile = parsed.data;
  const errors: string[] = [];
  if (containsPlaceholderWord(profile)) errors.push('profile contains a conventional zero/filler bytes32 placeholder');
  const contractTypes = profile.contracts.map((contract) => contract.type);
  if (new Set(contractTypes).size !== contractTypes.length || contractTypes.length !== requiredContractTypes.length || requiredContractTypes.some((type) => !contractTypes.includes(type))) errors.push('contract deployment inventory is incomplete, contains duplicates, or includes unexpected types');
  if (profile.artifactBundle.package !== bundle.packageName || profile.artifactBundle.version !== bundle.bundleVersion) errors.push('artifact package/version differs from pinned bundle');
  if (profile.artifactBundle.bundleRoot.toLowerCase().replace(/^0x/, '') !== bundle.bundleRoot.toLowerCase().replace(/^0x/, '')) errors.push('artifact bundle root differs from pinned bundle');
  if (profile.artifactBundle.sourceCommit !== bundle.source.commit || profile.artifactBundle.sourceDirty !== bundle.source.dirty) errors.push('artifact source provenance differs from pinned bundle');

  const architecture = localArchitecture as { contracts?: Record<string, { constructorBindings?: Record<string, unknown> }> };
  const adapterBindings = architecture.contracts?.['prf/source-bound-entitlement-verifier-adapter-v1']?.constructorBindings;
  const literal = (binding: unknown): unknown => (binding && typeof binding === 'object') ? (binding as Record<string, unknown>).literal : undefined;
  if (profile.proofProgram.vkey !== literal(adapterBindings?.vkey_)) errors.push('VKey differs from the existing successor local topology pin');
  if (profile.proofProgram.elfSha256 !== literal(adapterBindings?.elfSha256_)) errors.push('ELF digest differs from the existing successor local topology pin');

  const environment = localEnvironment as { bootstrapAssertions?: Array<Record<string, unknown>> };
  const schemaAssertion = (name: string) => environment.bootstrapAssertions?.find((assertion) =>
    assertion.target === 'prf/source-bound-entitlement-verifier-adapter-v1' && assertion.function === name,
  )?.expected;
  if (profile.proofProgram.publicValuesSchemaWord !== schemaAssertion('publicValuesSchema')) errors.push('public-values schema word differs from the adapter topology assertion');
  if (profile.proofProgram.statementSchemaWord !== schemaAssertion('statementSchemaVersion')) errors.push('statement schema word differs from the adapter topology assertion');

  const pinnedContracts = new Map(Object.entries(bundle.artifacts).map(([name, artifact]) => [name, artifact.runtimeBytecodeSha256.toLowerCase()]));
  for (const contract of profile.contracts) {
    if (pinnedContracts.get(contract.type) !== contract.runtimeBytecodeSha256.toLowerCase()) errors.push(`contract ${contract.type} runtime hash differs from pinned bundle`);
    if (bundle.artifacts[contract.type]?.artifactFile !== contract.artifact) errors.push(`contract ${contract.type} artifact path differs from pinned bundle`);
  }

  // This profile must fail closed until every externally controlled/deployment-
  // derived dependency is resolved. Never let placeholder roots or addresses
  // turn into an apparent ready/admitted state.
  if (profile.readiness.unresolvedDependencies.length > 0 && (profile.readiness.status !== 'blocked' || profile.readiness.deploymentEnabled || profile.readiness.admissionEnabled)) {
    errors.push('unresolved dependencies require blocked status and disabled deployment/admission');
  }
  if (profile.readiness.unresolvedDependencies.length === 0 && (profile.readiness.status !== 'ready' || !profile.readiness.deploymentEnabled || !profile.readiness.admissionEnabled || hasUnresolvedAuthority(profile.authorityMatrix))) errors.push('ready status requires no dependencies, all authority references resolved, and explicit deployment/admission enablement');
  if (keccak256(stringToHex(profile.proofProgram.publicValuesSchema)) !== profile.proofProgram.publicValuesSchemaWord.toLowerCase()) errors.push('public-values schema word is not the keccak256 of the pinned schema identifier');
  if (keccak256(stringToHex(profile.proofProgram.statementSchema)) !== profile.proofProgram.statementSchemaWord.toLowerCase()) errors.push('statement schema word is not the keccak256 of the pinned schema identifier');
  const readiness = errors.length === 0 && profile.readiness.unresolvedDependencies.length === 0 ? 'ready' : 'blocked';
  return {
    profileIntegrity: errors.length === 0 ? 'valid' : 'invalid',
    deploymentStatus: readiness,
    unresolvedDependencies: profile.readiness.unresolvedDependencies,
    errors,
  };
}

export function loadPinnedSuccessorEntitlementBundle(repoRoot: string): {
  manifest: ReturnType<BundleConsumer['loadManifest']>;
  localArchitecture: unknown;
  localEnvironment: unknown;
} {
  const bundle = new BundleConsumer(new FixtureBundleLocator(`${repoRoot}/fixtures/releases/0.4.0/packages`), { requirePinnedProvenance: true });
  const manifest = bundle.loadManifest('prf/deployables', '@protocol-robustness/prf-evm-deployables', '0.4.0');
  for (const artifactName of requiredContractTypes) bundle.loadArtifact('prf/deployables', '@protocol-robustness/prf-evm-deployables', '0.4.0', artifactName);
  return {
    manifest,
    localArchitecture: readEdnFile(`${repoRoot}/config/pro-rata-v2-entitlement/architecture.edn`),
    localEnvironment: readEdnFile(`${repoRoot}/config/pro-rata-v2-entitlement/environments/local.edn`),
  };
}
