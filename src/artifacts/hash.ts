import { createHash } from 'crypto';
import { keccak_256 } from '@noble/hashes/sha3';

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function sha256Hex(data: string | Uint8Array): string {
  const buf =
    typeof data === 'string'
      ? Buffer.from(data, 'utf8')
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256HexOfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function keccak256Hex(data: string | Uint8Array): string {
  const bytes = keccak_256(
    typeof data === 'string' ? new TextEncoder().encode(data) : data,
  );
  return toHex(bytes);
}

/** Hex-string normalization: lowercase, no 0x prefix. */
export function normalizeHex(value: string): string {
  let v = value.trim().toLowerCase();
  if (v.startsWith('0x')) v = v.slice(2);
  if (!/^[0-9a-f]*$/.test(v)) {
    throw new Error(`Not valid hex: ${value}`);
  }
  return v;
}

export function isHex(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^0x/, '');
  return v.length > 0 && /^[0-9a-f]+$/.test(v);
}

/**
 * Hash of bytecode (without 0x prefix) interpreted as ASCII characters.
 * Bytecode may contain library link placeholders (`__$<hex>$__`), so this is
 * not restricted to pure hex. Matches the exporter-side convention.
 */
export function bytecodeHash(bytecode: string): string {
  return sha256Hex(normalizeBytecode(bytecode));
}

/** Normalize bytecode string: lowercase, strip 0x, validate charset/shape. */
export function normalizeBytecode(value: string): string {
  let v = value.trim().toLowerCase();
  if (v.startsWith('0x')) v = v.slice(2);
  if (v.length === 0 || !/^[0-9a-f_$]+$/.test(v)) {
    throw new Error(`Invalid bytecode (not hex/placeholders): ${value.slice(0, 40)}...`);
  }
  const ph = v.match(/__\$[0-9a-f]+\$__/g) ?? [];
  for (const p of ph) {
    if (p.slice(3, -3).length === 0) throw new Error(`Malformed library placeholder: ${p}`);
  }
  return v;
}

export function isBytecode(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^0x/, '');
  if (v.length === 0 || !/^[0-9a-f_$]+$/.test(v)) return false;
  const ph = v.match(/__\$[0-9a-f]+\$__/g) ?? [];
  return ph.every((p) => p.slice(3, -3).length > 0);
}
