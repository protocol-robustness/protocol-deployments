import * as fs from 'fs';
import * as path from 'path';
import { resolveDeployment } from '../resolve-deployment';
import { loadDefaultEnvFile } from '../config/env-file';
import { ConfigError } from '../errors';
import { verifyPrfInitialInputApproval, type PrfInitialApprovalEvidence } from '../deployment/prf-initial-approval';

function usage(): never {
  console.error('Usage: resolve.ts --env <environment> [--config-dir <dir>] [--profile <dir>] [--plan <plan.json> --prf-root <dir> --initial-input-manifest <file> --candidate-package-set <file> --initial-input-approval <file> --prf-trusted-context <file>] [--fixtures <dir>] [--cross-plan-stage-output-evidence <dir>] [--out <file>] [--pinned-artifacts]');
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
  let initialApprovalEvidence: PrfInitialApprovalEvidence | undefined;
  if (arg('plan')) {
    const required = {
      prfRoot: arg('prf-root'),
      manifestPath: arg('initial-input-manifest'),
      packageSetPath: arg('candidate-package-set'),
      approvalPath: arg('initial-input-approval'),
      trustedContextPath: arg('prf-trusted-context'),
    };
    if (Object.values(required).some((value) => !value)) {
      throw new ConfigError('PRF_INITIAL_APPROVAL_REQUIRED', 'Plan resolution requires authenticated source-bound initial inputs to replace constructor root sentinels');
    }
    initialApprovalEvidence = verifyPrfInitialInputApproval(required as { prfRoot: string; manifestPath: string; packageSetPath: string; approvalPath: string; trustedContextPath: string });
  }

  const out = resolveDeployment({
    configDir,
    environment,
    fixtureRoot,
    profileDir,
    preferFixtures: !pinned,
    requirePinnedProvenance: pinned,
    deploymentPlanFile: arg('plan') ? path.resolve(process.cwd(), arg('plan')!) : undefined,
    crossPlanStageOutputEvidenceDir: arg('cross-plan-stage-output-evidence') ? path.resolve(process.cwd(), arg('cross-plan-stage-output-evidence')!) : undefined,
    approvedRootBindings: initialApprovalEvidence?.approvedRootBindings,
  });

  const outPath =
    arg('out') ?? path.resolve(process.cwd(), 'deployments', `${environment}.resolved.json`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = JSON.stringify(
    { specHash: out.specHash, environment: out.spec.environment, spec: out.spec, initialInputApproval: initialApprovalEvidence },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  fs.writeFileSync(outPath, payload + '\n');

  console.log(`Resolved ${environment}`);
  console.log(`  specHash: ${out.specHash}`);
  console.log(`  contracts: ${Object.keys(out.spec.contracts).length}`);
  if (arg('plan')) console.log(`  plan:      ${path.resolve(process.cwd(), arg('plan')!)}`);
  console.log(`  chainId: ${out.spec.chain.chainId}`);
  console.log(`  output: ${outPath}`);
}

main();
