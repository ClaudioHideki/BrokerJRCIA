import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { runInAdminTransaction } from '../../src/modules/organizations/repository.js';

describe('runInAdminTransaction', () => {
  it('preserva erro original e descarta conexão quando o rollback também falha', async () => {
    const operationError = new Error('operation failed');
    const rollbackError = new Error('rollback failed');
    const releasedWith: unknown[] = [];
    const client = {
      async query(text: string) {
        if (text === 'ROLLBACK') {
          throw rollbackError;
        }
        if (text.includes('pg_has_role')) {
          return { rows: [{ canSetRole: true }] };
        }
        return { rows: [] };
      },
      release(error?: unknown) {
        releasedWith.push(error);
      },
    };
    const pool = { connect: async () => client } as unknown as Pool;

    const rejection = await runInAdminTransaction(pool, async () => {
      throw operationError;
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([operationError, rollbackError]);
    expect(releasedWith).toEqual([rollbackError]);
  });
});
