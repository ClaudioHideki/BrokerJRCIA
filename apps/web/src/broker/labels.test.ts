import { expect, it } from 'vitest';
import { connectionAccountLabel } from './labels.js';

it('preserva a distinção de contas antigas usando a marca JRC', () => {
  expect(connectionAccountLabel('Baileys matriz')).toBe('JRC QR Code matriz');
  expect(connectionAccountLabel('Evolution API · filial')).toBe('JRC QR Code · filial');
  expect(connectionAccountLabel('Atendimento comercial')).toBe('Atendimento comercial');
});
