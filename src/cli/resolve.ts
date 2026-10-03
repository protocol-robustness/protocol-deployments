import * as fs from 'fs';
import * as path from 'path';
import { resolveDeployment } from '../resolve-deployment';
import { loadDefaultEnvFile } from '../config/env-file';

function usage(): never {
  console.error('Usage: resolve.ts --env <environment> [--config-dir <dir>] [--fixtures <dir>] [--out <file>] [--pinned-artifacts]');
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function main(): void {
  loadDefaultEnvFile();
  const environment = arg('env');
  if (!environment) usage();

  const configDir = arg('config-dir') ?? path.resolve(process.cwd(), 'config');
  const fixtureRoot = arg('fixtures') ?? path.resolve(process.cwd(), 'fixtures', 'packages');
  const profileDir = arg('profile') ? path.resolve(process.cwd(), arg('profile')!) : undefined;
  const pinned = process.argv.includes('--pinned-artifacts');

  const out = resolveDeployment({
    configDir,
    environment,
    fixtureRoot,
    profileDir,
    preferFixtures: !pinned,
    requirePinnedProvenance: pinned,
  });

  const outPath =
    arg('out') ?? path.resolve(process.cwd(), 'deployments', `${environment}.resolved.json`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = JSON.stringify(
    { specHash: out.specHash, environment: out.spec.environment, spec: out.spec },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  fs.writeFileSync(outPath, payload + '\n');

  console.log(`Resolved ${environment}`);
  console.log(`  specHash: ${out.specHash}`);
  console.log(`  contracts: ${Object.keys(out.spec.contracts).length}`);
  console.log(`  chainId: ${out.spec.chain.chainId}`);
  console.log(`  output: ${outPath}`);
}

main();
