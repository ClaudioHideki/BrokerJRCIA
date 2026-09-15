import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  initializePasswordVerifier,
  verifyPassword,
} from '../src/index.js';

describe('senhas Argon2id', () => {
  it('gera hash Argon2id e valida somente a senha correta', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('gera o hash fictício na inicialização e faz uma verificação por tentativa', async () => {
    const operations: string[] = [];
    const verifier = await initializePasswordVerifier({
      async hash() {
        operations.push('hash');
        return 'precomputed-dummy-hash';
      },
      async verify(hash, candidate) {
        operations.push(`verify:${hash}:${candidate}`);
        return hash === 'known-user-hash' && candidate === 'candidate password';
      },
    });

    expect(operations).toEqual(['hash']);
    await expect(
      verifier.verifyPasswordOrDummy('candidate password', 'known-user-hash'),
    ).resolves.toBe(true);
    await expect(
      verifier.verifyPasswordOrDummy('candidate password', null),
    ).resolves.toBe(false);
    expect(operations).toEqual([
      'hash',
      'verify:known-user-hash:candidate password',
      'verify:precomputed-dummy-hash:candidate password',
    ]);
  });
});
