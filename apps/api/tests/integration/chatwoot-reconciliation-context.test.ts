import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { chatwootEnvironment, createChatwootService, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';

describe('Chatwoot reconciliation context fence', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 60_000);
  afterAll(async () => { await db?.dispose(); });

  async function fixture(mutation?: string) {
    const tenant = await seedAttendanceTenant(db.database);
    const calls: { method: string; path: string }[] = [];
    const options: ChatwootOptions = {
      baseUrl: `https://${tenant.org}.example.test`, publicOrigin: 'https://broker.example.test',
      encryptionKey: Buffer.alloc(32, 6).toString('base64'), transact: db.transact,
      resolveIntegration: async id => id === tenant.integration ? tenant.org : undefined,
      async fetch(input, init) {
        const path = new URL(String(input)).pathname;
        calls.push({ method: init?.method ?? 'GET', path });
        if (init?.method !== 'GET' || path !== '/api/v1/accounts/7/conversations/51') {
          throw new Error('Unexpected synthetic request');
        }
        // The service already captured context. Commit the competing configuration
        // change before it receives the previously valid remote conversation.
        if (mutation) await db.database.pool.query(mutation, [tenant.org]);
        return Response.json({ id: 51, account_id: 7, inbox_id: 9, status: 'pending',
          meta: { sender: { id: 41, phone_number: '+15550000101' } } });
      },
    };
    const vault = chatwootEnvironment(options).vault;
    await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',
      [tenant.org, vault.encrypt(`${tenant.org}:chatwoot-account`, 'synthetic-token')]);
    await db.database.pool.query("UPDATE messaging_contacts SET external_id='15550000101' WHERE organization_id=$1", [tenant.org]);
    const messageId = randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_messages
      (id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
      VALUES($1::uuid,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic reconciliation"}',
        'SENT',$1::text,$5)`, [messageId, tenant.org, tenant.channel, tenant.conversation, 'a'.repeat(64)]);
    const payload = { operation: 'CREATE_CONVERSATION', contactId: 41, marker: 'preserve-this-field' };
    const jobs = await db.database.pool.query(`UPDATE integration_jobs SET status='UNKNOWN',payload=$3,
      last_error='synthetic_uncertain' WHERE organization_id=$1 AND message_id=$2 RETURNING id`,
    [tenant.org, messageId, payload]);
    expect(jobs.rows).toHaveLength(1);
    const jobId = jobs.rows[0]!.id as string;
    const readJob = async () => (await db.transact(tenant.org, tx => tx.query(
      'SELECT status,payload,last_error,available_at,updated_at FROM integration_jobs WHERE id=$1', [jobId]))).rows[0];
    const audits = async () => (await db.transact(tenant.org, tx => tx.query(
      'SELECT action,resource_id,reason,actor_id FROM integration_audit WHERE resource_id=$1 ORDER BY created_at,id', [jobId]))).rows;
    return { ...tenant, service: createChatwootService(options), calls, jobId, payload, readJob, audits };
  }

  it.each([
    ['credential rotation', 'UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1'],
    ['destination revision', 'UPDATE chatwoot_destinations SET revision=revision+1 WHERE organization_id=$1'],
    ['destination revocation', "UPDATE chatwoot_destinations SET approval_status='REVOKED' WHERE organization_id=$1"],
    ['account remapping', 'UPDATE chatwoot_accounts SET account_id=8 WHERE organization_id=$1'],
    ['inbox remapping', 'UPDATE chatwoot_connections SET inbox_id=10 WHERE organization_id=$1'],
    ['account suspension', "UPDATE chatwoot_accounts SET status='DISABLED' WHERE organization_id=$1"],
    ['connection pause', "UPDATE chatwoot_connections SET status='DISABLED' WHERE organization_id=$1"],
  ])('preserves UNKNOWN and its payload after %s during the remote GET', async (_name, mutation) => {
    const t = await fixture(mutation);
    const before = await t.readJob();
    await expect(t.service.reconcileJob(t.org, t.jobId, 'Synthetic review', 51))
      .rejects.toMatchObject({ code: 'CHATWOOT_CONTEXT_CHANGED', status: 409 });
    expect(await t.readJob()).toEqual(before);
    expect(await t.audits()).toEqual([]);
    expect(t.calls).toEqual([{ method: 'GET', path: '/api/v1/accounts/7/conversations/51' }]);
  });

  it('reconciles an unchanged context once and records exactly one audit without an external write', async () => {
    const t = await fixture(), actorId = randomUUID();
    await expect(t.service.reconcileJob(t.org, t.jobId, 'Synthetic review', 51, actorId)).resolves.toEqual({ ok: true });
    expect(await t.readJob()).toMatchObject({ status: 'PENDING', payload: { ...t.payload, conversationId: 51 }, last_error: null });
    expect(await t.audits()).toEqual([{ action: 'JOB_RECONCILED', resource_id: t.jobId, reason: 'Synthetic review', actor_id: actorId }]);
    await expect(t.service.reconcileJob(t.org, t.jobId, 'Duplicate review', 51, actorId))
      .rejects.toMatchObject({ code: 'JOB_REQUIRES_RECONCILIATION', status: 409 });
    expect(await t.audits()).toHaveLength(1);
    expect(t.calls).toEqual([{ method: 'GET', path: '/api/v1/accounts/7/conversations/51' }]);
  });

  it('preserves a competing UNKNOWN payload update during the remote GET without auditing stale reconciliation', async () => {
    const t = await fixture(`UPDATE integration_jobs SET payload=payload||'{"contactId":99,"marker":"concurrent"}'::jsonb
      WHERE organization_id=$1 AND status='UNKNOWN'`);
    const before = await t.readJob();
    await expect(t.service.reconcileJob(t.org, t.jobId, 'Stale payload review', 51))
      .rejects.toMatchObject({ code: 'JOB_REQUIRES_RECONCILIATION', status: 409 });
    expect(await t.readJob()).toEqual({ ...before, payload: { ...t.payload, contactId: 99, marker: 'concurrent' } });
    expect(await t.audits()).toEqual([]);
    expect(t.calls).toEqual([{ method: 'GET', path: '/api/v1/accounts/7/conversations/51' }]);
  });

  it('rejects another tenant before remote I/O and preserves the owner job and audit', async () => {
    const t = await fixture(), other = await seedAttendanceTenant(db.database), before = await t.readJob();
    await expect(t.service.reconcileJob(other.org, t.jobId, 'Foreign tenant review', 51))
      .rejects.toMatchObject({ code: 'JOB_REQUIRES_RECONCILIATION', status: 409 });
    expect((await db.transact(other.org, tx => tx.query('SELECT id FROM integration_jobs WHERE id=$1', [t.jobId]))).rows).toEqual([]);
    expect(await t.readJob()).toEqual(before);
    expect(await t.audits()).toEqual([]);
    expect(t.calls).toEqual([]);
  });
});
