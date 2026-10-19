import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCapitalFlowExpectations } from '../src/deployment/capital-flow-expectations';

const temporaryDirectories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'capital-flow-expectations-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('trusted capital-flow expectation input', () => {
  it('reads JSON from a relative path inside the independently selected root', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'qualification'));
    writeFileSync(join(root, 'qualification', 'expected.json'), '{"schema":"protocol-capital-flow-expectations/v1"}');
    expect(readCapitalFlowExpectations(root, 'qualification/expected.json'))
      .toEqual({ schema: 'protocol-capital-flow-expectations/v1' });
  });

  it.each(['../expected.json', join(tmpdir(), 'expected.json'), '.', ''])('rejects path %j outside the selected root', (relative) => {
    const root = temporaryDirectory();
    expect(() => readCapitalFlowExpectations(root, relative))
      .toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_INVALID' }));
  });

  it('rejects a symlink that resolves outside the selected root', () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    const target = join(outside, 'expected.json');
    writeFileSync(target, '{"schema":"protocol-capital-flow-expectations/v1"}');
    symlinkSync(target, join(root, 'expected.json'));
    expect(() => readCapitalFlowExpectations(root, 'expected.json'))
      .toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_INVALID' }));
  });

  it('rejects malformed expectation JSON', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'expected.json'), '{');
    expect(() => readCapitalFlowExpectations(root, 'expected.json'))
      .toThrowError(expect.objectContaining({ code: 'CAPITAL_FLOW_EXPECTATIONS_INVALID' }));
  });
});
