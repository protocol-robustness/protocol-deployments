/**
 * Generates deterministic mock deployable artifact packages under
 * fixtures/packages. These stand in for the real versioned deployables that
 * prf-evm and sew-protocol will publish. The generator computes real hashes so
 * the bundle consumer's integrity validation is exercised faithfully.
 *
 * This is a Phase 1 fixture generator only — it is not part of the runtime
 * resolver and is not shipped.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const ROOT = path.resolve(process.cwd(), 'fixtures', 'packages');

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
function shaStr(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const CONTRACTS: Array<{ pkg: string; repo: string; version: string; compiler: string; names: string[] }> = [
  {
    pkg: '@sew/deployables',
    repo: 'sew/sew-protocol',
    version: '0.1.0',
    compiler: '0.8.26',
    names: ['SEWGovToken', 'SEWTimelock', 'SEWGovernor', 'EscrowVault', 'DecentralizedResolutionModule'],
  },
  {
    pkg: '@protocol-robustness/prf-evm-deployables',
    repo: 'protocol-robustness/prf-evm',
    version: '0.1.0',
    compiler: '0.8.26',
    names: ['PrfVerifierRegistry', 'SP1Verifier', 'PrfStatementAdmission'],
  },
];

function mockAbi(name: string): unknown[] {
  return [
    {
      type: 'constructor',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'initialOwner', type: 'address' },
        { name: 'param0', type: 'uint256' },
      ],
    },
    {
      type: 'function',
      name: 'version',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'string' }],
    },
    {
      type: 'function',
      name: 'name',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ name: '', type: 'string' }],
    },
    {
      type: 'event',
      name: `${name}Deployed`,
      inputs: [{ name: 'who', type: 'address', indexed: true }],
      anonymous: false,
    },
  ];
}

/** Deterministic mock bytecode derived from the contract name. */
function mockBytecode(name: string, deployed: boolean): string {
  const base = createHash('sha256').update(`${name}:${deployed ? 'runtime' : 'creation'}`).digest('hex');
  const hex = '60' + base.slice(0, 62) + (deployed ? '00' : '80');
  return '0x' + hex;
}

function writePackage(def: (typeof CONTRACTS)[number]): void {
  const pkgDir = path.join(ROOT, ...def.pkg.split('/'));
  const artDir = path.join(pkgDir, 'artifacts');
  fs.mkdirSync(artDir, { recursive: true });

  const artifacts: Record<string, unknown> = {};

  for (const name of def.names) {
    const artifact = {
      name,
      abi: mockAbi(name),
      bytecode: mockBytecode(name, false),
      deployedBytecode: mockBytecode(name, true),
      metadata: `ipfs://mock-${def.version}-${name.toLowerCase()}`,
    };
    const json = JSON.stringify(artifact, null, 2);
    const fileBuf = Buffer.from(json + '\n', 'utf8');
    const artifactRel = `artifacts/${name}.json`;
    fs.writeFileSync(path.join(pkgDir, artifactRel), fileBuf);

    artifacts[name] = {
      path: artifactRel,
      sha256: sha(fileBuf),
      abiSha256: shaStr(JSON.stringify(artifact.abi)),
      creationBytecodeSha256: shaStr(artifact.bytecode.replace(/^0x/, '')),
      deployedBytecodeSha256: shaStr(artifact.deployedBytecode.replace(/^0x/, '')),
    };
  }

  const manifest = {
    package: def.pkg,
    version: def.version,
    sourceRepo: def.repo,
    sourceCommit: `mock-${def.version}-${def.repo.split('/').pop()}`,
    compiler: { name: 'solc', version: def.compiler, settings: { optimizer: { enabled: true, runs: 200 } } },
    artifacts,
  };
  fs.writeFileSync(
    path.join(pkgDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  // eslint-disable-next-line no-console
  console.log(`wrote ${def.pkg}@${def.version} (${def.names.length} artifacts)`);
}

for (const def of CONTRACTS) writePackage(def);
