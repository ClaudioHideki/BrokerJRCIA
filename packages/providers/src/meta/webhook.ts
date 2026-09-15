import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook contract references reviewed 2026-09-14:
 * https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 *
 * Meta's developer page returned an internal error during this implementation;
 * signature behavior is therefore covered by local HMAC contract tests and must
 * still be checked during authorized Meta environment homologation.
 */

export const META_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

export type MetaWebhookErrorCode =
  | 'INVALID_META_WEBHOOK_CONFIGURATION'
  | 'INVALID_META_WEBHOOK_INPUT';

export interface MetaWebhookError extends Error {
  code: MetaWebhookErrorCode;
}

export interface MetaWebhookSignatureInput {
  appSecret: string;
  rawBody: Buffer;
  signature: string | undefined;
}

export interface MetaWebhookChallengeInput {
  expectedVerifyToken: string;
  mode: unknown;
  verifyToken: unknown;
  challenge: unknown;
}

function metaWebhookError(code: MetaWebhookErrorCode): MetaWebhookError {
  return Object.assign(new Error(code), {
    name: 'MetaWebhookError',
    code,
  });
}

function validServerSecret(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyMetaWebhookSignature(input: MetaWebhookSignatureInput): boolean {
  if (
    typeof input !== 'object'
    || input === null
    || !validServerSecret(input.appSecret)
    || !Buffer.isBuffer(input.rawBody)
    || input.rawBody.byteLength > META_WEBHOOK_MAX_BODY_BYTES
  ) {
    throw metaWebhookError('INVALID_META_WEBHOOK_INPUT');
  }
  if (typeof input.signature !== 'string' || !/^sha256=[a-f0-9]{64}$/u.test(input.signature)) {
    return false;
  }

  const suppliedDigest = Buffer.from(input.signature.slice('sha256='.length), 'hex');
  const expectedDigest = createHmac('sha256', input.appSecret).update(input.rawBody).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export function verifyMetaWebhookChallenge(input: MetaWebhookChallengeInput): string | null {
  if (typeof input !== 'object' || input === null || !validServerSecret(input.expectedVerifyToken)) {
    throw metaWebhookError('INVALID_META_WEBHOOK_CONFIGURATION');
  }
  if (
    input.mode !== 'subscribe'
    || typeof input.verifyToken !== 'string'
    || input.verifyToken.length === 0
    || Buffer.byteLength(input.verifyToken, 'utf8') > 4_096
    || typeof input.challenge !== 'string'
    || input.challenge.length === 0
    || input.challenge.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(input.challenge)
  ) {
    return null;
  }
  return constantTimeStringEqual(input.verifyToken, input.expectedVerifyToken)
    ? input.challenge
    : null;
}
