import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export const EMBED_SESSION_TOKEN_ALGORITHM = 'HS256';
export const EMBED_SESSION_TOKEN_ISSUER = 'jrc-whatsapp-broker';
export const EMBED_SESSION_TOKEN_AUDIENCE = 'jrc-chatwoot-embed';
export const EMBED_SESSION_TOKEN_TTL_SECONDS = 300;
export const EMBED_SESSION_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

const EmbedSessionClaimsSchema = z.strictObject({
  tenantId: z.uuid(),
  destinationRevision: z.number().int().positive(),
  accountId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  inboxIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate inbox'),
  externalUserId: z.string().min(1).max(256),
  scopes: z.array(z.enum(['chatwoot:read', 'chatwoot:pair'])).min(1).max(2)
    .refine(scopes => new Set(scopes).size === scopes.length, 'Duplicate scope'),
  nonce: z.uuid(),
});

export type EmbedSessionTokenClaims = z.infer<typeof EmbedSessionClaimsSchema>;

function secretKey(secret: string): Uint8Array {
  const key = Buffer.from(secret, 'utf8');
  if (key.byteLength < 32) throw new Error('Embed session secret must contain at least 32 bytes');
  return key;
}

export async function issueEmbedSessionToken(
  input: EmbedSessionTokenClaims,
  secret: string,
  now = new Date(),
): Promise<string> {
  const claims = EmbedSessionClaimsSchema.parse(input);
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({
    tenant_id: claims.tenantId,
    destination_revision: claims.destinationRevision,
    account_id: claims.accountId,
    inbox_ids: claims.inboxIds,
    external_user_id: claims.externalUserId,
    scopes: claims.scopes,
  })
    .setProtectedHeader({ alg: EMBED_SESSION_TOKEN_ALGORITHM, typ: 'JWT' })
    .setIssuer(EMBED_SESSION_TOKEN_ISSUER)
    .setAudience(EMBED_SESSION_TOKEN_AUDIENCE)
    .setSubject(claims.externalUserId)
    .setJti(claims.nonce)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + EMBED_SESSION_TOKEN_TTL_SECONDS)
    .sign(secretKey(secret));
}

export async function verifyEmbedSessionToken(
  token: string,
  secret: string,
  now = new Date(),
): Promise<EmbedSessionTokenClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: [EMBED_SESSION_TOKEN_ALGORITHM],
    issuer: EMBED_SESSION_TOKEN_ISSUER,
    audience: EMBED_SESSION_TOKEN_AUDIENCE,
    currentDate: now,
    clockTolerance: 0,
    requiredClaims: ['sub', 'jti', 'iat', 'exp'],
  });
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
    (payload.exp as number) - (payload.iat as number) !== EMBED_SESSION_TOKEN_TTL_SECONDS ||
    payload.sub !== payload.external_user_id || payload.jti === undefined) {
    throw new Error('Invalid embed session claims');
  }
  if ((payload.iat as number) > Math.floor(now.getTime() / 1000) + EMBED_SESSION_TOKEN_CLOCK_TOLERANCE_SECONDS)
    throw new Error('Embed session token was issued in the future');
  return EmbedSessionClaimsSchema.parse({
    tenantId: payload.tenant_id,
    destinationRevision: payload.destination_revision,
    accountId: payload.account_id,
    inboxIds: payload.inbox_ids,
    externalUserId: payload.external_user_id,
    scopes: payload.scopes,
    nonce: payload.jti,
  });
}
