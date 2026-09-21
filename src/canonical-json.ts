/**
 * Deterministic canonical JSON serialization.
 *
 * This byte-for-byte matches the canonical serialization used by the
 * SEW/PRF deployable-artifact exporters (sorted keys, `": "` separator,
 * no insignificant whitespace, bigint as decimal string, `undefined` omitted).
 * The ABI/constructor hashes recorded in exported manifests are computed over
 * this exact representation, so the consumer MUST produce identical bytes to
 * verify them. It is also used for the frozen deployment-spec hash.
 */

type JsonCompat = string | number | boolean | null | bigint | JsonCompat[] | { [k: string]: JsonCompat };

function serialize(value: JsonCompat, indent: number, depth: number): string {
  const pad = (n: number): string => ' '.repeat(n);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value.map((v) => `${pad(indent + depth)}${serialize(v, indent, depth + 1)}`);
    return `[\n${inner.join(',\n')}\n${pad(indent + depth - indent)}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  if (keys.length === 0) return '{}';
  const inner = keys.map(
    (k) => `${pad(indent + depth)}${JSON.stringify(k)}: ${serialize((value as Record<string, JsonCompat>)[k]!, indent, depth + 1)}`,
  );
  return `{\n${inner.join(',\n')}\n${pad(indent + depth - indent)}}`;
}

/** Deterministic compact JSON (sorted keys, `": "` separator, no whitespace). */
export function canonicalJson(value: unknown): string {
  const pretty = serialize(value as JsonCompat, 0, 0);
  return pretty.replace(/\n\s*/g, '');
}
