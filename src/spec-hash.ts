import { keccak256Hex } from './artifacts/hash';
import { canonicalJson } from './canonical-json';

/**
 * Deterministic deployment-spec hash.
 *
 * The hash is computed over the canonical JSON of the fully resolved,
 * frozen specification (which contains no unresolved logical references and
 * excludes any observed/ledger state). The domain separator makes the hash
 * self-describing and versioned.
 */
export const SPEC_HASH_DOMAIN = 'prf-deployment-spec:v1:';

export function computeSpecHash(resolvedSpec: unknown): string {
  const canonical = canonicalJson(resolvedSpec);
  return `0x${keccak256Hex(`${SPEC_HASH_DOMAIN}${canonical}`)}`;
}
