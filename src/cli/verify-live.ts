import * as fs from 'fs';
import * as path from 'path';
import { createTransport } from '../runtime/transport';
import { verifyLiveDeployment } from '../deployment/live-verification';
import { BundleConsumer, FixtureBundleLocator } from '../artifacts/bundle';
import type { DeploymentManifestV1 } from '../deployment/manifest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): never {
  console.error('Usage: verify-live.ts --manifest <path> --rpc-url <url> [--resolved <path>] [--fixtures <dir>] [--block <number>] [--out <path>]');
  process.exit(2);
}

async function main(): Promise<void> {
  const manifestPath = arg('manifest');
  const rpcUrl = arg('rpc-url') ?? process.env.RPC_URL;
  if (!manifestPath || !rpcUrl) usage();

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DeploymentManifestV1;
  const resolvedPath = arg('resolved');
  const resolved = resolvedPath
    ? (JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as { spec: import('../canonical').ResolvedSpec }).spec
    : undefined;
  const fixtureRoot = arg('fixtures') ?? path.resolve(process.cwd(), 'fixtures', 'packages');
  const bundle = new BundleConsumer(new FixtureBundleLocator(fixtureRoot));
  const blockArg = arg('block');
  const verification = await verifyLiveDeployment(
    manifest,
    createTransport(rpcUrl),
    blockArg === undefined ? undefined : BigInt(blockArg),
    resolved,
    bundle,
  );

  const outPath = arg('out') ?? path.join(
    path.dirname(manifestPath),
    `${path.basename(manifestPath, '.json')}.${verification.verificationRoot.slice(2, 14)}.deployment-verification.v1.json`,
  );
  if (fs.existsSync(outPath)) throw new Error(`Refusing to overwrite existing verification artifact: ${outPath}`);
  fs.writeFileSync(outPath, JSON.stringify(verification, null, 2) + '\n');
  console.log(`✅ Live deployment verification passed (${verification.verificationRoot})`);
  console.log(`   output: ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
