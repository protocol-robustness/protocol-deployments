import * as fs from 'fs';

/**
 * Minimal `.env` loader (no dependency): read `KEY=VALUE` lines from a file and
 * populate `process.env` only for keys that are not already set, so an explicit
 * shell export always wins. Values may be quoted; `#` starts a comment.
 *
 * Secrets are never printed by this module.
 */
export function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Load `.env` from the current working directory, if present. */
export function loadDefaultEnvFile(): void {
  loadEnvFile(`${process.cwd()}/.env`);
}
