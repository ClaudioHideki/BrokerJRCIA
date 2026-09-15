import type { ConnectionAction } from '@jrc/contracts';

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const MAX_PNG_BYTES = 1_500_000;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function invalidQr(): never {
  throw new Error('QR Code inválido ou inseguro. Solicite um novo desafio.');
}

export function safeQrPngDataUrl(
  action: Extract<ConnectionAction, { type: 'QR_CODE' }>,
  now = new Date(),
): string {
  const expiresAt = Date.parse(action.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error('O QR Code expirou. Solicite um novo desafio.');
  }

  const base64 = action.encoding === 'DATA_URL'
    ? action.value.startsWith(PNG_DATA_URL_PREFIX)
      ? action.value.slice(PNG_DATA_URL_PREFIX.length)
      : invalidQr()
    : action.value;

  if (
    base64.length === 0
    || base64.length > 2_000_000
    || base64.length % 4 !== 0
    || !CANONICAL_BASE64.test(base64)
  ) invalidQr();

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return invalidQr();
  }
  if (binary.length > MAX_PNG_BYTES || btoa(binary) !== base64) invalidQr();
  if (binary.length < PNG_SIGNATURE.length) invalidQr();
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (binary.charCodeAt(index) !== PNG_SIGNATURE[index]) invalidQr();
  }

  return `${PNG_DATA_URL_PREFIX}${base64}`;
}
