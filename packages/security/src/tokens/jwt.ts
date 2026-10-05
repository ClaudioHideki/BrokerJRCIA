import { randomUUID } from 'node:crypto';

import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export const ACCESS_TOKEN_ALGORITHM = 'HS256';
export const ACCESS_TOKEN_ISSUER = 'jrc-whatsapp-broker';
export const ACCESS_TOKEN_AUDIENCE = 'jrc-api';
export const ACCESS_TOKEN_TTL_SECONDS = 600;
export const ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

export interface AccessTokenIdentity {
  userId: string;
  /** Omitted only for pre-generation callers; generation zero cannot survive a reset. */
  authVersion?: number;
  organizationId: string;
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
}

export interface AccessTokenPayload extends JWTPayload {
  sub: string;
  auth_version: number;
  organization_id: string;
  role: AccessTokenIdentity['role'];
}

function secretKey(secret: string): Uint8Array {
  const key = Buffer.from(secret, 'utf8');
  if (key.byteLength < 32) {
    throw new Error('JWT secret must contain at least 32 bytes');
  }
  return key;
}

export async function issueAccessToken(
  identity: AccessTokenIdentity,
  secret: string,
  now = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const authVersion = identity.authVersion ?? 0;
  if (!Number.isSafeInteger(authVersion) || authVersion < 0) throw new Error('Invalid authentication generation');

  return new SignJWT({
    organization_id: identity.organizationId,
    role: identity.role,
    auth_version: authVersion,
  })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: 'JWT' })
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(identity.userId)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: [ACCESS_TOKEN_ALGORITHM],
    issuer: ACCESS_TOKEN_ISSUER,
    audience: ACCESS_TOKEN_AUDIENCE,
    currentDate: now,
    clockTolerance: ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
    requiredClaims: ['sub', 'jti', 'iat', 'exp'],
  });

  // Tokens issued before migration belong exclusively to generation zero.
  if (payload.auth_version === undefined) payload.auth_version = 0;
  if (
    !Number.isSafeInteger(payload.auth_version)
    || (payload.auth_version as number) < 0
    || typeof payload.sub !== 'string'
    || typeof payload.jti !== 'string'
    || payload.jti.length === 0
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || (payload.exp as number) - (payload.iat as number) !== ACCESS_TOKEN_TTL_SECONDS
    || typeof payload.organization_id !== 'string'
    || !['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'].includes(String(payload.role))
  ) {
    throw new Error('Invalid access token claims');
  }

  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if ((payload.iat as number) > nowSeconds + ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS) {
    throw new Error('Access token was issued in the future');
  }

  return payload as AccessTokenPayload;
}
