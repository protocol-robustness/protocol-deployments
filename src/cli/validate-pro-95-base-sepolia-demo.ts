import * as fs from 'fs';
import * as path from 'path';
import { validatePro95DemoProfile } from '../validate/pro-95-demo-profile';

const root = path.resolve(__dirname, '../..');
const profilePath = path.join(root, 'config/pro-95-base-sepolia-demo/profile.v1.json');
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as unknown;
const result = validatePro95DemoProfile(profile);
console.log(`PRO-95 Base Sepolia demo profile: ${result.valid ? 'VALID / BLOCKED' : 'INVALID'}`);
for (const error of result.errors) console.error(`ERROR: ${error}`);
if (!result.valid) process.exitCode = 1;
