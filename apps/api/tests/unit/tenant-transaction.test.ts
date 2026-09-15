import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

function createDatabaseHarness(identity = { currentUser: 'jrc_app', sessionUser: 'jrc_app' }) {
  const events: string[] = [];
  const queries: Array<{ text: string; values: readonly unknown[] | undefined }> = [];
  const release = vi.fn(() => {
    events.push('release');
  });
  const client = {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queries.push({ text, values });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        events.push(text.toLowerCase());
      } else if (text.includes('current_user') && text.includes('session_user')) {
        events.push('verify-role');
        return { rows: [identity], rowCount: 1 };
      } else if (text.includes("set_config('app.organization_id'")) {
        events.push('set-context');
      }
      return { rows: [], rowCount: 0 };
    }),
    release,
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => {
      events.push('connect');
      return client;
    }),
  } as unknown as Pool;

  return { client, events, pool, queries, release };
}

describe('withOrganizationTransaction', () => {
  it('confirma a transação e libera a conexão antes de resolver', async () => {
    const harness = createDatabaseHarness();

    const result = await withOrganizationTransaction(
      harness.pool,
      ORGANIZATION_ID,
      async (transaction) => {
        expect(transaction).toBe(harness.client);
        harness.events.push('operation');
        return 'persisted';
      },
    );

    expect(result).toBe('persisted');
    expect(harness.events).toEqual([
      'connect',
      'begin',
      'verify-role',
      'set-context',
      'operation',
      'commit',
      'release',
    ]);
    expect(harness.queries[2]).toEqual({
      text: "SELECT set_config('app.organization_id', $1, true)",
      values: [ORGANIZATION_ID],
    });
  });

  it('faz rollback, libera a conexão e preserva o erro da operação', async () => {
    const harness = createDatabaseHarness();
    const failure = new Error('operation failed');

    await expect(withOrganizationTransaction(
      harness.pool,
      ORGANIZATION_ID,
      async () => {
        harness.events.push('operation');
        throw failure;
      },
    )).rejects.toBe(failure);

    expect(harness.events).toEqual([
      'connect',
      'begin',
      'verify-role',
      'set-context',
      'operation',
      'rollback',
      'release',
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('rejeita conexão administrativa mesmo quando current_user assume jrc_app', async () => {
    const harness = createDatabaseHarness({ currentUser: 'jrc_app', sessionUser: 'postgres' });
    const operation = vi.fn(async () => 'must-not-run');

    await expect(withOrganizationTransaction(
      harness.pool,
      ORGANIZATION_ID,
      operation,
    )).rejects.toThrow('Organization transactions require a direct jrc_app connection');

    expect(operation).not.toHaveBeenCalled();
    expect(harness.events).toEqual(['connect', 'begin', 'verify-role', 'rollback', 'release']);
    expect(harness.queries.some(({ text }) => text.includes("set_config('app.organization_id'"))).toBe(false);
  });
});
