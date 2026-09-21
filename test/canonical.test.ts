import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../src/canonical-json';
import { computeSpecHash } from '../src/spec-hash';
import { resolveEdn } from './helpers';

describe('canonical JSON + spec hash', () => {
  it('is deterministic regardless of object key insertion order', () => {
    const a = canonicalJson({ z: 1, a: 2, m: { b: 3, a: 4 } });
    const b = canonicalJson({ a: 2, m: { a: 4, b: 3 }, z: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a": 2,"m": {"a": 4,"b": 3},"z": 1}');
  });

  it('serializes bigint as decimal string', () => {
    expect(canonicalJson({ v: 123n })).toBe('{"v": "123"}');
  });

  it('omits undefined fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a": 1}');
  });

  it('produces a stable spec hash for the resolved spec', () => {
    const one = resolveEdn();
    const two = resolveEdn();
    expect(one.specHash).toBe(two.specHash);
    expect(one.specHash).toMatch(/^0x[0-9a-f]{64}$/);
    // hash is a pure function of the canonical json
    expect(computeSpecHash(one.spec)).toBe(one.specHash);
  });
});
