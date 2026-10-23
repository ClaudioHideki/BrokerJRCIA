import { describe, expect, it } from 'vitest';

import { compareMigrationStatus, loadExpectedMigrations } from './schema-status.js';

const expected = [
  { name: '0001_roles', hash: 'hash-1', createdAt: 1000 },
  { name: '0002_identity', hash: 'hash-2', createdAt: 2000 },
  { name: '0003_channels', hash: 'hash-3', createdAt: 3000 },
] as const;

describe('schema status read-only', () => {
  it('carrega o manifesto real até a migration 0073', async () => {
    const migrations = await loadExpectedMigrations();
    expect(migrations).toHaveLength(73);
    expect(migrations.slice(-3).map(entry => entry.name)).toEqual([
      '0071_partner_messaging_authority', '0072_chatwoot_campaign_intents', '0073_chatwoot_initial_identity',
    ]);
  });

  it('informa a versão aplicada e migrations pendentes sem expor hashes', () => {
    expect(compareMigrationStatus(expected, [
      { hash: 'hash-1', createdAt: 1000 },
      { hash: 'hash-2', createdAt: 2000 },
    ])).toEqual({
      state: 'PENDING',
      compatible: false,
      expectedVersion: '0003_channels',
      appliedVersion: '0002_identity',
      expectedCount: 3,
      appliedCount: 2,
      pending: ['0003_channels'],
    });
  });

  it('marca o schema atual quando o prefixo e a quantidade conferem', () => {
    expect(compareMigrationStatus(expected, expected.map(({ hash, createdAt }) => ({ hash, createdAt })))).toMatchObject({
      state: 'CURRENT',
      compatible: true,
      pending: [],
    });
  });

  it('falha fechado quando a história aplicada diverge', () => {
    expect(compareMigrationStatus(expected, [
      { hash: 'other-hash', createdAt: 1000 },
    ])).toEqual({
      state: 'DIVERGED',
      compatible: false,
      expectedVersion: '0003_channels',
      appliedVersion: null,
      expectedCount: 3,
      appliedCount: 1,
      pending: [],
    });
  });
});
