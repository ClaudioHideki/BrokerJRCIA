import { createHash, createHmac, randomBytes } from 'node:crypto';

export type RandomBytesSource = (size: number) => Uint8Array;

export function createOpaqueToken(random: RandomBytesSource = randomBytes): string {
  return Buffer.from(random(32)).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashRefreshToken(token: string, secret: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Refresh token hash secret must contain at least 32 bytes');
  }
  return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}
