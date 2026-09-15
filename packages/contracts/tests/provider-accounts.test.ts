import { describe, expect, it } from 'vitest';

type ProviderAccountModule = {
  ProviderAccountPageSchema?: { parse(value: unknown): unknown };
};

async function loadProviderAccounts(): Promise<ProviderAccountModule> {
  try {
    const url = new URL('../src/provider-accounts/schemas.js', import.meta.url).href;
    return await import(url) as ProviderAccountModule;
  } catch {
    return {};
  }
}

describe('contratos de provider accounts', () => {
  it('aceita somente metadados paginados sem referências de credencial', async () => {
    const contract = await loadProviderAccounts();
    const page = {
      data: [{
        id: 'ac282057-7f9c-4a91-93c9-82e4cedfa157',
        name: 'Conta Baileys',
        provider: 'BAILEYS',
        createdAt: '2030-01-01T00:00:00.000Z',
      }],
      pageInfo: { hasNextPage: false, nextCursor: null },
    };

    expect(contract.ProviderAccountPageSchema?.parse(page)).toEqual(page);
    expect(() => contract.ProviderAccountPageSchema?.parse({
      ...page,
      data: [{ ...page.data[0], credentialReference: 'must-not-leak' }],
    })).toThrow();
  });
});
