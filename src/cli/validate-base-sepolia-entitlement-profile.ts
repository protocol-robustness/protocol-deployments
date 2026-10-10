import * as fs from 'fs';
import * as path from 'path';
import { loadPinnedSuccessorEntitlementBundle, validateSuccessorEntitlementProfile } from '../validate/successor-entitlement-profile';

const root = path.resolve(__dirname, '../..');
const profilePath = path.join(root, 'config/pro-rata-v2-entitlement/base-sepolia.profile.json');
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as unknown;
const pins = loadPinnedSuccessorEntitlementBundle(root);
const result = validateSuccessorEntitlementProfile(profile, pins.manifest, pins.localArchitecture, pins.localEnvironment);

console.log(`Profile integrity: ${result.profileIntegrity.toUpperCase()}`);
console.log(`Base Sepolia deployment: ${result.deploymentStatus.toUpperCase()}`);
for (const dependency of result.unresolvedDependencies) console.log(`BLOCKED: ${dependency}`);
for (const error of result.errors) console.error(`ERROR: ${error}`);
if (result.profileIntegrity !== 'valid') process.exitCode = 1;
