import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

import {
  createOpaqueToken,
  hashOpaqueToken,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
} from '../src/index.js';

const jwtSecret = 'jwt-secret-with-at-least-thirty-two-bytes';
const opaqueHashSecret = 'opaque-hash-secret-with-at-least-32-bytes';
const now = new Date('2030-01-01T12:00:00.000Z');

describe('tokens opacos', () => {
  it('gera 256 bits e mantém somente hash determinístico', () => {
    const raw = createOpaqueToken(() => Buffer.alloc(32, 9));

    expect(raw).toHaveLength(43);
    expect(hashOpaqueToken(raw)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOpaqueToken(raw)).toBe(hashOpaqueToken(raw));
    expect(hashOpaqueToken(raw)).not.toContain(raw);
    expect(hashRefreshToken(raw, opaqueHashSecret)).not.toBe(
      hashRefreshToken(raw, 'different-opaque-hash-secret-32-bytes'),
    );
  });
});

describe('JWT de acesso', () => {
  it('fixa algoritmo, emissor, audiência e expiração', async () => {
    const token = await issueAccessToken({
      userId: '2d5ac7d0-ce4c-4af0-a287-5df4994b22e6',
      organizationId: '0885a52b-15e0-4869-9f2e-7f9d52ad3aef',
      role: 'OWNER',
    }, jwtSecret, now);

    await expect(verifyAccessToken(token, jwtSecret, now)).resolves.toMatchObject({
      sub: '2d5ac7d0-ce4c-4af0-a287-5df4994b22e6',
      organization_id: '0885a52b-15e0-4869-9f2e-7f9d52ad3aef',
      role: 'OWNER',
      iss: 'jrc-whatsapp-broker',
      aud: 'jrc-api',
      iat: 1_893_499_200,
      exp: 1_893_499_800,
    });
  });

  it('rejeita segredo incorreto', async () => {
    const token = await issueAccessToken({
      userId: '2d5ac7d0-ce4c-4af0-a287-5df4994b22e6',
      organizationId: '0885a52b-15e0-4869-9f2e-7f9d52ad3aef',
      role: 'OWNER',
    }, jwtSecret, now);

    await expect(verifyAccessToken(
      token,
      'different-jwt-secret-with-thirty-two-bytes',
      now,
    )).rejects.toThrow();
  });

  it.each([
    [{ alg: 'HS256' }, { iss: 'jrc-whatsapp-broker', aud: 'jrc-api', sub: 'user', organization_id: 'org', role: 'OWNER', iat: 1_893_499_200, exp: 1_893_499_800 }, 'jti ausente'],
    [{ alg: 'HS256' }, { iss: 'wrong-issuer', aud: 'jrc-api', sub: 'user', jti: 'id', organization_id: 'org', role: 'OWNER', iat: 1_893_499_200, exp: 1_893_499_800 }, 'issuer incorreto'],
    [{ alg: 'HS256' }, { iss: 'jrc-whatsapp-broker', aud: 'wrong-audience', sub: 'user', jti: 'id', organization_id: 'org', role: 'OWNER', iat: 1_893_499_200, exp: 1_893_499_800 }, 'audience incorreta'],
    [{ alg: 'HS256' }, { iss: 'jrc-whatsapp-broker', aud: 'jrc-api', sub: 'user', jti: 'id', organization_id: 'org', role: 'OWNER', iat: 1_893_499_200, exp: 1_893_499_801 }, 'TTL diferente'],
  ])('rejeita token com %s', async (header, payload) => {
    const token = await new SignJWT(payload)
      .setProtectedHeader(header)
      .sign(Buffer.from(jwtSecret));
    await expect(verifyAccessToken(token, jwtSecret, now)).rejects.toThrow();
  });

  it('rejeita algoritmo diferente de HS256', async () => {
    const token = await new SignJWT({
      organization_id: 'org', role: 'OWNER', iat: 1_893_499_200, exp: 1_893_499_800,
    })
      .setProtectedHeader({ alg: 'HS384' })
      .setIssuer('jrc-whatsapp-broker')
      .setAudience('jrc-api')
      .setSubject('user')
      .setJti('id')
      .sign(Buffer.from(jwtSecret));
    await expect(verifyAccessToken(token, jwtSecret, now)).rejects.toThrow();
  });

  it('rejeita token emitido no futuro além da tolerância de relógio', async () => {
    const future = new Date('2040-01-01T12:00:00.000Z');
    const token = await issueAccessToken({
      userId: '2d5ac7d0-ce4c-4af0-a287-5df4994b22e6',
      organizationId: '0885a52b-15e0-4869-9f2e-7f9d52ad3aef',
      role: 'OWNER',
    }, jwtSecret, future);

    await expect(verifyAccessToken(token, jwtSecret, now)).rejects.toThrow(
      'Access token was issued in the future',
    );
  });

  it('aceita somente a fronteira documentada de 30 segundos para clock skew', async () => {
    const atBoundary = new Date(now.getTime() + 30_000);
    const beyondBoundary = new Date(now.getTime() + 31_000);
    const identity = {
      userId: '2d5ac7d0-ce4c-4af0-a287-5df4994b22e6',
      organizationId: '0885a52b-15e0-4869-9f2e-7f9d52ad3aef',
      role: 'OWNER' as const,
    };

    await expect(verifyAccessToken(
      await issueAccessToken(identity, jwtSecret, atBoundary),
      jwtSecret,
      now,
    )).resolves.toMatchObject({ iat: 1_893_499_230, exp: 1_893_499_830 });
    await expect(verifyAccessToken(
      await issueAccessToken(identity, jwtSecret, beyondBoundary),
      jwtSecret,
      now,
    )).rejects.toThrow('Access token was issued in the future');
  });
});
