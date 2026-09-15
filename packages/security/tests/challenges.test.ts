import { describe, expect, it } from 'vitest';

import { decryptChallenge, encryptChallenge } from '../src/index.js';

describe('desafios AES-256-GCM', () => {
  const key = Buffer.alloc(32, 7);

  it('cifra e autentica o desafio sem manter o texto aberto', () => {
    const encrypted = encryptChallenge('challenge-canary-value', key, () => Buffer.alloc(12, 3));

    expect(JSON.stringify(encrypted)).not.toContain('challenge-canary-value');
    expect(decryptChallenge(encrypted, key)).toBe('challenge-canary-value');
  });

  it('rejeita ciphertext adulterado', () => {
    const encrypted = encryptChallenge('challenge-canary-value', key, () => Buffer.alloc(12, 3));
    const tampered = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.startsWith('A') ? 'B' : 'A'}${encrypted.ciphertext.slice(1)}`,
    };

    expect(() => decryptChallenge(tampered, key)).toThrow();
  });
});
