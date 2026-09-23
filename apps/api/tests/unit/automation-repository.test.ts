import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';

describe('PostgreSQL automation repository', () => {
  it('qualifies every claimExecution RETURNING column with the updated table alias', async () => {
    const query = vi.fn(async (text: string) => {
      if (/\bfrom candidate c\b/i.test(text) && /\breturning\s+id\b/i.test(text)) {
        throw Object.assign(new Error('column reference "id" is ambiguous'), { code: '42702' });
      }

      const returning = text.match(/\breturning\s+(.+)$/i)?.[1];
      expect(returning).toBeDefined();
      for (const column of returning!.split(',')) {
        expect(column.trim()).toMatch(/^e\./);
      }
      return { rows: [], rowCount: 0 };
    });
    const transaction = { query } as unknown as TenantTransaction;

    await expect(
      createPostgresAutomationRepository().claimExecution(
        transaction,
        randomUUID(),
        randomUUID(),
        30_000,
      ),
    ).resolves.toBeNull();
  });
});
