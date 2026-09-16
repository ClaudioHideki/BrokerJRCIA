import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyEmbedProof } from '../../src/modules/integrations/embed/authorization.js';

describe('embedded authorization proof', () => {
  const verifier = 'v'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  it('requires the verifier for this exact request', () => {
    expect(verifyEmbedProof(verifier, challenge)).toBe(true);
    expect(verifyEmbedProof('other'.repeat(16), challenge)).toBe(false);
  });
  it.each(['', 'v'.repeat(42), 'v'.repeat(129), '!'.repeat(64), ' '.repeat(64)])('rejects malformed verifiers', value => {
    expect(verifyEmbedProof(value, challenge)).toBe(false);
  });
  it.each(['', challenge + '=', challenge + 'a', 'x'.repeat(43), '+'.repeat(43)])('rejects malformed or unrelated challenges', value => {
    expect(verifyEmbedProof(verifier, value)).toBe(false);
  });
});
