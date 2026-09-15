import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  META_WEBHOOK_MAX_BODY_BYTES,
  verifyMetaWebhookChallenge,
  verifyMetaWebhookSignature,
} from '../src/meta/webhook.js';

describe('verifyMetaWebhookSignature', () => {
  it('validates the HMAC-SHA256 over the exact raw Buffer bytes', () => {
    const rawBody = Buffer.from('{"text":"olá","spacing":"a  b"}', 'utf8');
    const digest = createHmac('sha256', 'app-secret').update(rawBody).digest('hex');

    expect(verifyMetaWebhookSignature({
      appSecret: 'app-secret',
      rawBody,
      signature: `sha256=${digest}`,
    })).toBe(true);
  });

  it('rejects a signature made from reserialized bytes', () => {
    const rawBody = Buffer.from('{"a":1, "b":2}', 'utf8');
    const changedBytes = Buffer.from('{"a":1,"b":2}', 'utf8');
    const digest = createHmac('sha256', 'app-secret').update(changedBytes).digest('hex');

    expect(verifyMetaWebhookSignature({
      appSecret: 'app-secret',
      rawBody,
      signature: `sha256=${digest}`,
    })).toBe(false);
  });

  it.each([
    undefined,
    '',
    'sha1=0000000000000000000000000000000000000000',
    'sha256=abc',
    `SHA256=${'0'.repeat(64)}`,
    `sha256=${'G'.repeat(64)}`,
    `sha256=${'0'.repeat(64)}extra`,
  ])('strictly rejects malformed signature %s', (signature) => {
    expect(verifyMetaWebhookSignature({
      appSecret: 'app-secret',
      rawBody: Buffer.from('{}'),
      signature,
    })).toBe(false);
  });

  it.each([
    [{ appSecret: '', rawBody: Buffer.from('{}'), signature: `sha256=${'0'.repeat(64)}` }],
    [{ appSecret: 'x'.repeat(4_097), rawBody: Buffer.from('{}'), signature: `sha256=${'0'.repeat(64)}` }],
    [{ appSecret: 'app-secret', rawBody: Buffer.alloc(META_WEBHOOK_MAX_BODY_BYTES + 1), signature: `sha256=${'0'.repeat(64)}` }],
    [{ appSecret: 'app-secret', rawBody: '{}' as unknown as Buffer, signature: `sha256=${'0'.repeat(64)}` }],
  ])('rejects invalid bounded verifier input without exposing it', (input) => {
    expect(() => verifyMetaWebhookSignature(input)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_META_WEBHOOK_INPUT',
        message: 'INVALID_META_WEBHOOK_INPUT',
      }),
    );
  });
});

describe('verifyMetaWebhookChallenge', () => {
  it('returns the bounded challenge for an exact subscribe token match', () => {
    expect(verifyMetaWebhookChallenge({
      expectedVerifyToken: 'server-verify-token',
      mode: 'subscribe',
      verifyToken: 'server-verify-token',
      challenge: '1234567890',
    })).toBe('1234567890');
  });

  it.each([
    [{ mode: 'unsubscribe', verifyToken: 'server-verify-token', challenge: '123' }],
    [{ mode: 'subscribe', verifyToken: 'wrong', challenge: '123' }],
    [{ mode: 'subscribe', verifyToken: 'server-verify-token ', challenge: '123' }],
    [{ mode: 'subscribe', verifyToken: 'server-verify-token', challenge: '' }],
    [{ mode: 'subscribe', verifyToken: 'server-verify-token', challenge: 'x'.repeat(1_025) }],
    [{ mode: 'subscribe', verifyToken: 'server-verify-token', challenge: 123 }],
  ])('rejects an invalid or unauthorized verification query', (query) => {
    expect(verifyMetaWebhookChallenge({
      expectedVerifyToken: 'server-verify-token',
      ...query,
    })).toBeNull();
  });

  it('rejects an invalid server token without exposing it', () => {
    expect(() => verifyMetaWebhookChallenge({
      expectedVerifyToken: '',
      mode: 'subscribe',
      verifyToken: '',
      challenge: '123',
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_META_WEBHOOK_CONFIGURATION',
      message: 'INVALID_META_WEBHOOK_CONFIGURATION',
    }));
  });
});
