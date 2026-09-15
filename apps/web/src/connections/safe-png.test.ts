import { describe, expect, it } from 'vitest';

import { safeQrPngDataUrl } from './safe-png.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3aQAAAAASUVORK5CYII=';

describe('safeQrPngDataUrl', () => {
  it('aceita PNG canônico em BASE64 ou data URL exata', () => {
    const expiresAt = '2030-01-01T12:00:00.000Z';
    expect(safeQrPngDataUrl({ type: 'QR_CODE', encoding: 'BASE64', value: PNG_BASE64, expiresAt }, new Date('2030-01-01T11:59:00Z')))
      .toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(safeQrPngDataUrl({ type: 'QR_CODE', encoding: 'DATA_URL', value: `data:image/png;base64,${PNG_BASE64}`, expiresAt }, new Date('2030-01-01T11:59:00Z')))
      .toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  it.each([
    ['SVG', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['URL remota', 'https://example.test/qr.png'],
    ['JavaScript', 'javascript:alert(1)'],
    ['bytes que não são PNG', 'UklGRmFrZQ=='],
    ['base64 com espaço', `${PNG_BASE64} `],
  ])('recusa %s', (_label, value) => {
    expect(() => safeQrPngDataUrl({
      type: 'QR_CODE',
      encoding: value.startsWith('data:') ? 'DATA_URL' : 'BASE64',
      value,
      expiresAt: '2030-01-01T12:00:00.000Z',
    }, new Date('2030-01-01T11:59:00Z'))).toThrow('QR Code inválido');
  });

  it('recusa desafio expirado', () => {
    expect(() => safeQrPngDataUrl({
      type: 'QR_CODE', encoding: 'BASE64', value: PNG_BASE64,
      expiresAt: '2030-01-01T12:00:00.000Z',
    }, new Date('2030-01-01T12:00:00Z'))).toThrow('expirou');
  });
});
