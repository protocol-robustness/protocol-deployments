import { describe, it, expect } from 'vitest';
import { parseEdn } from '../src/config/edn';
import { ConfigError } from '../src/errors';

describe('EDN reader', () => {
  it('parses keywords, maps, vectors, sets, bigints, strings', () => {
    const v = parseEdn(
      `{:a :sew/escrow :b #{1 2 3} :c [1 2] :d 1000000000000000000N :e "hi" :f nil}`,
      't',
    ) as Record<string, unknown>;
    expect(v.a).toBe('sew/escrow');
    expect(v.b).toEqual([1, 2, 3]);
    expect(v.c).toEqual([1, 2]);
    expect(v.d).toBe(1000000000000000000n);
    expect(v.e).toBe('hi');
    expect(v.f).toBeNull();
  });

  it('ignores comments and commas', () => {
    const v = parseEdn('; note\n{:a 1, :b 2}', 't') as Record<string, unknown>;
    expect(v).toEqual({ a: 1, b: 2 });
  });

  it('rejects duplicate map keys', () => {
    expect(() => parseEdn('{:a 1 :a 2}', 't')).toThrow(ConfigError);
    try {
      parseEdn('{:a 1 :a 2}', 't');
    } catch (e) {
      expect((e as ConfigError).code).toBe('DUPLICATE_LOGICAL_ID');
    }
  });

  it('rejects unsupported tagged literals', () => {
    expect(() => parseEdn('#inst "2020-01-01"', 't')).toThrow(ConfigError);
  });

  it('rejects unterminated maps and trailing content', () => {
    expect(() => parseEdn('{:a 1', 't')).toThrow(ConfigError);
    expect(() => parseEdn('{:a 1} extra', 't')).toThrow(ConfigError);
  });
});
