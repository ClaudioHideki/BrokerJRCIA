import { describe, expect, it } from 'vitest';

import {
  scanHighConfidenceSecretMaterial,
  scanPublicContract,
} from '../../../../scripts/security/check-public-contracts.mjs';

describe('public contract boundary scanner', () => {
  it('detecta nomes e operações específicas do upstream', () => {
    expect(scanPublicContract('export type X = { evolutionInstanceName: string }')).toEqual([
      expect.objectContaining({ rule: 'no-upstream-public-contract' }),
    ]);
    expect(scanPublicContract('export async function deprovisionInstance() {}')).toEqual([
      expect.objectContaining({ rule: 'no-admin-provider-public-contract' }),
    ]);
  });

  it('aceita o contrato canônico próprio da JRC', () => {
    expect(scanPublicContract('export type X = { instanceId: string; provider: "BAILEYS" | "META" }'))
      .toEqual([]);
  });

  it('detecta material secreto de alta confiança sem versionar um segredo-fixture', () => {
    const token = ['gh', 'p_', 'A'.repeat(40)].join('');
    expect(scanHighConfidenceSecretMaterial(`export const leaked = '${token}'`)).toBe(true);
    expect(scanHighConfidenceSecretMaterial('export const safe = "canonical"')).toBe(false);
  });
});
