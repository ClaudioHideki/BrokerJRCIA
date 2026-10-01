import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';
import * as authority from '../../src/modules/attendance/runtime-authority.js';
import * as attendance from '../../src/modules/attendance/repository.js';

afterEach(() => vi.restoreAllMocks());

describe('PostgreSQL automation repository', () => {
  function fixture(options: { empty?: boolean; lockedElsewhere?: boolean; allowed?: boolean; emptyUpdate?: boolean } = {}) {
    const org = randomUUID(), id = randomUUID(), channelId = randomUUID(), token = randomUUID();
    const execution = {
      id, organizationId: org, channelId, conversationId: null, automationId: randomUUID(), version: 1,
      bindingId: randomUUID(), correlationId: randomUUID(), status: 'QUEUED', currentNodeId: null,
      state: {}, input: {}, errorCode: null, attempts: 0, startedAt: new Date(0), updatedAt: new Date(0),
      completedAt: null, leaseToken: null,
    };
    const admitted = { ...execution, status: 'RUNNING', attempts: 1, leaseToken: token };
    const lock = vi.spyOn(attendance, 'lockAttendanceChannelRead').mockResolvedValue(undefined);
    const authorize = vi.spyOn(authority, 'runtimeAuthorityAllows').mockResolvedValue(options.allowed !== false);
    const query = vi.fn(async (statement: string, params: readonly unknown[] = []) => {
      const sql = statement.replace(/\s+/g, ' ').trim();
      expect(params[0]).toBe(org);
      if (/^select id,channel_id AS "channelId" from automation_executions/i.test(sql)) {
        expect(sql).toContain('organization_id=$1');
        expect(sql).toContain("status='QUEUED'");
        expect(sql).toContain('lease_expires_at<now()');
        expect(sql).toContain('runtime_feature.enabled');
        return { rows: options.empty ? [] : [{ id, channelId }], rowCount: options.empty ? 0 : 1 };
      }
      if (/^select /i.test(sql) && sql.includes('id=any($2::uuid[])')) {
        expect(sql).toMatch(/order by id for no key update skip locked/i);
        expect(params[1]).toEqual(options.empty ? [] : [id]);
        if (!options.empty) expect(lock).toHaveBeenCalledWith(transaction, org, channelId);
        const rows = options.empty || options.lockedElsewhere ? [] : [execution];
        return { rows, rowCount: rows.length };
      }
      if (/^update automation_executions set /i.test(sql)) {
        expect(sql).toContain("status='RUNNING'");
        expect(sql).toContain('attempts=attempts+1');
        expect(sql).toContain('lease_token=$3');
        expect(sql).toContain('where organization_id=$1 and id=$2');
        // RETURNING is unambiguous: this UPDATE has no joined FROM table.
        expect(sql).not.toMatch(/\bfrom\b/i);
        const returning = sql.match(/\breturning (.+)$/i)?.[1];
        expect(returning).toBeDefined();
        expect(returning!.split(',')).toContain('id');
        expect(returning).toContain('organization_id AS "organizationId"');
        expect(returning).toContain('lease_token AS "leaseToken"');
        expect(params).toEqual([org, id, token, 30_000]);
        expect(authorize).toHaveBeenCalledWith(transaction, execution);
        return { rows: options.emptyUpdate ? [] : [admitted], rowCount: options.emptyUpdate ? 0 : 1 };
      }
      throw new Error(`Unexpected claim query: ${sql}`);
    });
    const transaction = { query } as unknown as TenantTransaction;
    return { org, id, token, admitted, query, lock, authorize,
      run: () => createPostgresAutomationRepository().claimExecution(transaction, org, token, 30_000) };
  }
  it('returns null for no candidates without treating discovery SELECTs as UPDATE RETURNING', async () => {
    const f = fixture({ empty: true });
    await expect(f.run()).resolves.toBeNull();
    expect(f.lock).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => /^\s*update\b/i.test(sql))).toBe(false);
  });
  it('does not update candidates locked by another transaction', async () => {
    const f = fixture({ lockedElsewhere: true });
    await expect(f.run()).resolves.toBeNull();
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.query.mock.calls.some(([sql]) => /^\s*update\b/i.test(sql))).toBe(false);
  });
  it('checks runtime authority before the tenant-scoped lease update and returns its row', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual(f.admitted);
    expect(f.query.mock.calls.filter(([sql]) => /^\s*update\b/i.test(sql))).toHaveLength(1);
  });
  it('does not reserve a lease when runtime authority denies the candidate', async () => {
    const f = fixture({ allowed: false });
    await expect(f.run()).resolves.toBeNull();
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(f.query.mock.calls.some(([sql]) => /^\s*update\b/i.test(sql))).toBe(false);
  });
  it('returns null rather than an invented claim when UPDATE RETURNING is empty', async () => {
    const f = fixture({ emptyUpdate: true });
    await expect(f.run()).resolves.toBeNull();
  });
});
