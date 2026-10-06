import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptyRecord, loadRecord, recordPathFor, saveRecord } from '../src/deployment/record';
import { ConfigError } from '../src/errors';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError && e.code === code) return;
    throw new Error(`expected ConfigError '${code}' but got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  }
  throw new Error(`expected ConfigError '${code}' but nothing was thrown`);
}

describe('deployment record loading', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-record-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when there is no record to resume from', () => {
    expect(loadRecord(recordPathFor(dir, 'local'))).toBeNull();
  });

  it('round-trips a saved record', () => {
    const recordPath = recordPathFor(dir, 'local');
    const record = emptyRecord({ specHash: '0xspec', environment: 'local', chainId: 31337 });
    saveRecord(recordPath, record);
    expect(loadRecord(recordPath)).toEqual(record);
  });

  it('fails closed on unparseable JSON', () => {
    const recordPath = recordPathFor(dir, 'local');
    fs.writeFileSync(recordPath, '{ truncated');
    expectCode(() => loadRecord(recordPath), 'RECORD_UNREADABLE');
  });

  it('fails closed on JSON that does not match the record schema', () => {
    const recordPath = recordPathFor(dir, 'local');
    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 1, status: 'not-a-status' }));
    expectCode(() => loadRecord(recordPath), 'RECORD_UNREADABLE');
  });
});
