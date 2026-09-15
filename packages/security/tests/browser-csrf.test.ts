import { describe, expect, it } from 'vitest';

import {
  createBrowserCsrfToken,
  isConsoleOriginAllowed,
  verifyBrowserCsrfToken,
} from '../src/index.js';

const CSRF_SECRET = 'browser-csrf-secret-with-at-least-32-bytes';

describe('proteção CSRF da sessão de navegador', () => {
  it('assina um nonce aleatório de 256 bits com HMAC-SHA-256', () => {
    const token = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 9));

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyBrowserCsrfToken(token, token, CSRF_SECRET)).toBe(true);
  });

  it('rejeita assinatura adulterada, segredo incorreto e divergência entre header e cookie', () => {
    const token = createBrowserCsrfToken(CSRF_SECRET, (size) => Buffer.alloc(size, 7));
    const [nonce, signature] = token.split('.');
    const replacement = signature?.startsWith('A') ? 'B' : 'A';
    const tampered = `${nonce}.${replacement}${signature?.slice(1)}`;

    expect(verifyBrowserCsrfToken(tampered, tampered, CSRF_SECRET)).toBe(false);
    expect(verifyBrowserCsrfToken(
      token,
      token,
      'different-browser-csrf-secret-with-32-bytes',
    )).toBe(false);
    expect(verifyBrowserCsrfToken(token, tampered, CSRF_SECRET)).toBe(false);
    expect(verifyBrowserCsrfToken('malformed', 'malformed', CSRF_SECRET)).toBe(false);
  });

  it('aceita somente associação exata do Origin, sem wildcard ou substring', () => {
    const allowed = ['https://console.jrc.example', 'http://localhost:5173'];

    expect(isConsoleOriginAllowed('https://console.jrc.example', allowed)).toBe(true);
    expect(isConsoleOriginAllowed('https://console.jrc.example.attacker.test', allowed)).toBe(false);
    expect(isConsoleOriginAllowed('https://console.jrc.example.evil', ['*.jrc.example'])).toBe(false);
    expect(isConsoleOriginAllowed(undefined, allowed)).toBe(false);
  });
});
