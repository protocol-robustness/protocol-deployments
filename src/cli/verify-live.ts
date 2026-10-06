import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { createTransport } from '../runtime/transport';
import { verifyLiveDeployment } from '../deployment/live-verification';
import { BundleConsumer, FixtureBundleLocator } from '../artifacts/bundle';
import type { ResolvedSpec } from '../canonical';
import type { DeploymentManifestV1 } from '../deployment/manifest';
import { ConfigError } from '../errors';
import { loadDefaultEnvFile } from '../config/env-file';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): never {
  console.error('Usage: verify-live.ts --manifest <path> --resolved <path> --rpc-url <url> [--fixtures <dir>] [--block <number>] [--out <path>]');
  process.exit(2);
}

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/, 'expected a 0x-prefixed hex string');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 20-byte address');
const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'expected a sha256 hex digest');
const uintString = z.string().regex(/^\d+$/, 'expected a decimal integer string');

/**
 * The manifest is externally supplied evidence, so it is parsed as untrusted
 * input rather than cast: a structurally invalid manifest must fail closed
 * before any chain read is attempted.
 */
const manifestSchema = z.object({
  type: z.literal('protocol-deployment-manifest/v1'),
  architectureSpecHash: z.string().min(1),
  executionSpecHash: z.string().min(1),
  deploymentId: z.string().min(1),
  chain: z.object({ id: z.number().int().positive(), blockNumber: uintString, blockHash: hex }),
  deployer: address,
  contracts: z.array(z.object({
    logicalId: z.string().min(1),
    address,
    artifact: z.object({
      source: z.string().min(1),
      package: z.string().min(1),
      version: z.string().min(1),
      artifactName: z.string().min(1),
      abiSha256: sha256,
      creationBytecodeSha256: sha256,
      runtimeBytecodeSha256: sha256,
    }),
    runtimeCodeHash: z.string().optional(),
    deploymentTx: hex,
    blockNumber: uintString,
  })).min(1),
  bootstrapActions: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['planned', 'submitted', 'confirmed', 'verified', 'failed']),
    transactionHash: hex.optional(),
    blockNumber: uintString.optional(),
    verification: z.string().optional(),
  })),
  finalAssertions: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(['passed', 'failed']),
    verifiedAt: z.string().min(1),
    detail: z.string().optional(),
  })),
});

/**
 * The resolved spec is machine-produced but file-supplied; validate its shape
 * enough that a truncated or unrelated file cannot reach the assertion loop.
 * The full type is restored afterwards because zod cannot express the closed
 * recursive binding unions the resolver emits.
 */
const resolvedFileSchema = z.object({
  specHash: z.string().min(1),
  environment: z.string().min(1),
  spec: z.object({
    specVersion: z.number(),
    environment: z.string().min(1),
    chain: z.object({ chainId: z.number().int().positive() }).passthrough(),
    contracts: z.record(z.string(), z.unknown()),
    deployment: z.object({
      steps: z.array(z.object({ logicalId: z.string().min(1) }).passthrough()).min(1),
      bootstrapAssertions: z.array(z.object({
        id: z.string().min(1),
        target: z.string().min(1),
        function: z.string().min(1),
        args: z.array(z.unknown()),
        expected: z.unknown(),
      }).passthrough()).optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

function readJson<T>(schema: z.ZodType<T>, file: string, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError('CONFIG_SCHEMA', `Cannot parse ${label} '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError('CONFIG_SCHEMA', `${label} '${file}' failed validation`, { details: { issues: parsed.error.issues } });
  }
  return parsed.data;
}

async function main(): Promise<void> {
  loadDefaultEnvFile();
  const manifestPath = arg('manifest');
  const resolvedPath = arg('resolved');
  const rpcUrl = arg('rpc-url') ?? process.env.RPC_URL;
  if (!manifestPath || !resolvedPath || !rpcUrl) usage();

  const manifest = readJson(manifestSchema, manifestPath, 'deployment manifest') as unknown as DeploymentManifestV1;
  const resolved = readJson(resolvedFileSchema, resolvedPath, 'resolved spec').spec as unknown as ResolvedSpec;

  const fixtureRoot = arg('fixtures') ?? path.resolve(process.cwd(), 'fixtures', 'packages');
  const bundle = new BundleConsumer(new FixtureBundleLocator(fixtureRoot));
  const blockArg = arg('block');
  const verification = await verifyLiveDeployment(
    manifest,
    createTransport(rpcUrl),
    resolved,
    bundle,
    blockArg === undefined ? undefined : BigInt(blockArg),
  );

  const outPath = arg('out') ?? path.join(
    path.dirname(manifestPath),
    `${path.basename(manifestPath, '.json')}.${verification.verificationRoot.slice(2, 14)}.deployment-verification.v1.json`,
  );
  if (fs.existsSync(outPath)) throw new ConfigError('VERIFY_OUTPUT_EXISTS', `Refusing to overwrite existing verification artifact: ${outPath}`);
  fs.writeFileSync(outPath, JSON.stringify(verification, null, 2) + '\n');
  console.log(`✅ Live deployment verification passed (${verification.verificationRoot})`);
  console.log(`   output: ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
