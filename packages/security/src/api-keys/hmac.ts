import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import ipaddr from 'ipaddr.js';

import type { RandomBytesSource } from '../tokens/opaque.js';

export interface CreatedApiKey {
  secret: string;
  prefix: string;
  hmac: string;
}

export interface ParsedOrganizationApiKey {
  organizationId: string;
  prefix: string;
}

function assertHmacSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('HMAC secret must contain at least 32 bytes');
  }
}

function deriveHmac(value: string, secret: string): string {
  assertHmacSecret(secret);
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function deriveIdentityRateLimitKey(email: string, secret: string): string {
  return deriveHmac(email.trim().toLowerCase(), secret);
}

export function deriveIpRateLimitKey(address: string, secret: string): string {
  if (!ipaddr.isValid(address)) {
    throw new Error('Invalid IP address');
  }

  const parsed = ipaddr.parse(address);
  const canonical = parsed.kind() === 'ipv6'
    ? parsed.toNormalizedString()
    : parsed.toString();

  return deriveHmac(canonical, secret);
}

export function createApiKey(
  hmacSecret: string,
  random: RandomBytesSource = randomBytes,
): CreatedApiKey {
  const prefix = Buffer.from(random(9)).toString('base64url');
  const keyMaterial = Buffer.from(random(32)).toString('base64url');
  const secret = `jrc_${prefix}_${keyMaterial}`;

  return {
    secret,
    prefix,
    hmac: deriveHmac(secret, hmacSecret),
  };
}

export function createOrganizationApiKey(
  organizationId: string,
  hmacSecret: string,
  random: RandomBytesSource = randomBytes,
): CreatedApiKey {
  const match = /^([a-f0-9]{8})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{12})$/i
    .exec(organizationId);
  if (!match) {
    throw new Error('Invalid organization ID');
  }
  const locator = match.slice(1).join('').toLowerCase();
  const prefixEntropy = Buffer.from(random(9)).toString('base64url');
  const prefix = `${locator}-${prefixEntropy}`;
  const keyMaterial = Buffer.from(random(32)).toString('base64url');
  const secret = `jrc_${prefix}_${keyMaterial}`;

  return {
    secret,
    prefix,
    hmac: deriveHmac(secret, hmacSecret),
  };
}

export function parseOrganizationApiKey(candidate: string): ParsedOrganizationApiKey | null {
  const match = /^jrc_([a-f0-9]{32}-[A-Za-z0-9_-]{12})_[A-Za-z0-9_-]{43}$/.exec(candidate);
  if (!match) return null;
  const prefix = match[1]!;
  const locator = prefix.slice(0, 32);
  return {
    organizationId: `${locator.slice(0, 8)}-${locator.slice(8, 12)}-${locator.slice(12, 16)}-${locator.slice(16, 20)}-${locator.slice(20)}`,
    prefix,
  };
}

export function verifyApiKey(
  candidate: string,
  expectedHmac: string,
  hmacSecret: string,
): boolean {
  const actual = Buffer.from(deriveHmac(candidate, hmacSecret), 'hex');
  const expected = Buffer.from(expectedHmac, 'hex');

  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}
