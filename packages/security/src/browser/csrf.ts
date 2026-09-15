import {
  createHmac,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

export type CsrfRandomBytesSource = (size: number) => Buffer;

const CSRF_NONCE_BYTES = 32;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

function assertCsrfSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Browser CSRF secret must contain at least 32 bytes');
  }
}

function signNonce(nonce: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(nonce, 'utf8').digest();
}

export function createBrowserCsrfToken(
  secret: string,
  randomBytes: CsrfRandomBytesSource = cryptoRandomBytes,
): string {
  assertCsrfSecret(secret);
  const nonceBytes = randomBytes(CSRF_NONCE_BYTES);
  if (nonceBytes.length !== CSRF_NONCE_BYTES) {
    throw new Error('CSRF random source must return exactly 32 bytes');
  }
  const nonce = nonceBytes.toString('base64url');
  return `${nonce}.${signNonce(nonce, secret).toString('base64url')}`;
}

export function verifyBrowserCsrfToken(
  headerToken: string | undefined,
  cookieToken: string | undefined,
  secret: string,
): boolean {
  assertCsrfSecret(secret);
  if (
    headerToken === undefined
    || cookieToken === undefined
    || !CSRF_TOKEN_PATTERN.test(headerToken)
    || !CSRF_TOKEN_PATTERN.test(cookieToken)
  ) {
    return false;
  }

  const [nonce, encodedSignature] = cookieToken.split('.');
  if (nonce === undefined || encodedSignature === undefined) return false;
  const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
  const expectedSignature = signNonce(nonce, secret);
  const headerMatchesCookie = timingSafeEqual(
    Buffer.from(headerToken, 'utf8'),
    Buffer.from(cookieToken, 'utf8'),
  );
  const signatureMatches = timingSafeEqual(suppliedSignature, expectedSignature);
  return headerMatchesCookie && signatureMatches;
}

export function isConsoleOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin !== undefined && allowedOrigins.includes(origin);
}
