import { describe, expect, it } from 'vitest';
import { assertSourceRevisionIdentity, assertSourceRevisionMatchesCheckout } from '../src/deployment/source-revision';

function expectConfigCode(run: () => void, code: string): void {
  try { run(); } catch (error) { expect(error).toMatchObject({ code }); return; }
  throw new Error(`Expected ConfigError ${code}`);
}

describe('stage-output source revision binding', () => {
  const head = 'a'.repeat(40);

  it('requires the declared revision to equal the clean executing checkout', () => {
    expect(() => assertSourceRevisionIdentity(head, head, true)).not.toThrow();
    expectConfigCode(() => assertSourceRevisionIdentity('b'.repeat(40), head, true), 'SOURCE_REVISION_MISMATCH');
    expectConfigCode(() => assertSourceRevisionIdentity(head, head, false), 'SOURCE_CHECKOUT_DIRTY');
    expectConfigCode(() => assertSourceRevisionIdentity('revision:source', head, true), 'SOURCE_REVISION_MISMATCH');
    expectConfigCode(() => assertSourceRevisionMatchesCheckout(head, '/missing/checkout'), 'SOURCE_REVISION_CHECK_FAILED');
  });
});
