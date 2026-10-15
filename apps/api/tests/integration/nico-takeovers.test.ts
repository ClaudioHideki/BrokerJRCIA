import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createChatwootControlAuth } from '../../src/modules/integrations/chatwoot-control-auth.js';
import { createNicoTakeovers } from '../../src/modules/integrations/nico-takeovers.js';
import { readChatwootAttendanceGate } from '../../src/modules/attendance/control-service.js';
import { createAttendanceResumeService } from '../../src/modules/attendance/resume-service.js';
import { probeRequiredRuntimeSchema } from '../../src/db/runtime-schema.js';

describe('NICO takeover durable authority under jrc_app', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
  afterAll(async () => { await db?.dispose(); });
  async function fixture() {
    const t = await seedAttendanceTenant(db.database);
    const origin = `https://${t.org}.example.test`;
    const actor = (await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1', [t.org])).rows[0].user_id;
    await db.database.pool.query("UPDATE chatwoot_accounts SET encrypted_token='synthetic-cipher' WHERE organization_id=$1", [t.org]);
    await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,13,'synthetic',11)`, [t.org, t.integration, t.conversation]);
    const auth = createChatwootControlAuth({ enabled: true, managedOrigin: origin, hmacSecret: 'synthetic-nico-at-least-32-characters',
      transact: db.transact, resolveCurrentRole: async () => 'OWNER' });
    const key = await auth.issueCredential({ kind: 'JWT', organizationId: t.org, actorId: actor, role: 'OWNER' },
      { name: 'NICO synthetic service', scopes: ['chatwoot:manage'], expiresAt: null }, randomUUID());
    const principal = await auth.authorize({ kind: 'API_KEY', organizationId: t.org, actorId: null, apiKeyId: key.id, scopes: key.scopes },
      'chatwoot:manage', t.integration, '42');
    const content = 'Synthetic approved message';
    const contentHash = createHash('sha256').update(content).digest('hex');
    const fingerprint = createHash('sha256').update(`jrc-nico-send-v1\n${t.org}\n7\n9\n11\n42\n${contentHash}`).digest('hex');
    const input = { requestId: randomUUID(), fingerprint, expectedOwnerRevision: 0, expectedAttendanceRevision: 0,
      expectedControlRevision: 0, expectedDestinationRevision: 1, expectedCredentialRevision: 1 };
    let activeTransactions = 0;
    const canonical = vi.fn(async () => { expect(activeTransactions).toBe(0); return {} as never; });
    const service = createNicoTakeovers({ auth, client: () => { expect(activeTransactions).toBe(0); return { canonicalMessage: canonical }; },
      transact: async (org, work) => { activeTransactions++; try { return await db.transact(org, work); } finally { activeTransactions--; } } });
    return { ...t, actor, auth, principal, input, content, canonical, service };
  }
  async function execution(t: Awaited<ReturnType<typeof fixture>>, status = 'SENT') {
    const binding=randomUUID(), execution=randomUUID(), outbox=randomUUID();
    await db.database.pool.query('INSERT INTO automation_bindings(organization_id,id,channel_id,automation_id,version) VALUES($1,$2,$3,$4,1)',[t.org,binding,t.channel,t.automation]);
    await db.database.pool.query(`INSERT INTO automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id)
      VALUES($1,$2,$3,1,$4,$5,$6,'synthetic', $7)`,[t.org,execution,t.automation,binding,t.channel,t.conversation,randomUUID()]);
    await db.database.pool.query(`INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,status) VALUES($1,$2,$3,'synthetic',0,'HANDOFF',$4)`,[t.org,outbox,execution,status]);
    return { execution,outbox };
  }
  async function deliveredMessage(t: Awaited<ReturnType<typeof fixture>>) {
    const id=randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id)
      VALUES($1,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic"}','DELIVERED','synthetic')`,[id,t.org,t.channel,t.conversation]);
    return id;
  }
  it('installs a tenant-isolated durable fence and receipt store', async () => {
    const row = (await db.database.pool.query(`SELECT to_regclass('public.nico_takeover_operations')::text AS name`)).rows[0];
    expect(row.name).toBe('nico_takeover_operations');
  });
  it('reads the exact mapped recipient, pauses once and preserves another conversation', async () => {
    const t = await fixture(), other = await fixture();
    expect(await t.service.attendance(t.principal, t.integration, 11)).toMatchObject({ accountId: 7, inboxId: 9, remoteContactId: 13, mode: 'BOT' });
    const first = await t.service.start(t.principal, t.integration, 11, t.input);
    expect(first).toMatchObject({ state: 'PAUSED', mode: 'HUMAN', attendanceRevision: 1, controlRevision: 1 });
    expect(await t.service.start(t.principal, t.integration, 11, t.input)).toEqual(first);
    expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1', [other.conversation])).rows[0].mode).toBe('BOT');
    await expect(t.service.start(t.principal, t.integration, 11, { ...t.input, fingerprint: 'b'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    await expect(t.service.start({ ...t.principal, externalActorId: '43' }, t.integration, 11, t.input)).rejects.toMatchObject({ status: 409 });
  });
  it('enforces service-only authority and current credential revocation', async () => {
    const t = await fixture();
    await expect(t.service.attendance({ ...t.principal, authentication: { kind: 'JWT', organizationId: t.org, actorId: t.actor, role: 'OWNER' } }, t.integration, 11)).rejects.toMatchObject({ status: 403 });
    await db.database.pool.query('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [t.principal.authentication.kind === 'API_KEY' ? t.principal.authentication.apiKeyId : null]);
    await expect(t.service.start(t.principal, t.integration, 11, t.input)).rejects.toMatchObject({ status: 403 });
    expect((await db.database.pool.query('SELECT 1 FROM nico_takeover_operations WHERE organization_id=$1', [t.org])).rowCount).toBe(0);
  });
  it('rejects stale confirmation before pausing or admitting an operation', async () => {
    const t = await fixture();
    await expect(t.service.start(t.principal, t.integration, 11, { ...t.input, expectedAttendanceRevision: 9 })).rejects.toMatchObject({ status: 409 });
    expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1', [t.conversation])).rows[0].mode).toBe('BOT');
  });
  it('keeps a persisted fence against gate, resume admission and direct BOT writes', async () => {
    const t = await fixture();
    await t.service.start(t.principal, t.integration, 11, t.input);
    expect(await db.transact(t.org, tx => readChatwootAttendanceGate(tx, { organizationId: t.org, channelId: t.channel, conversationId: t.conversation }))).toMatchObject({ allowed: false });
    await expect(createAttendanceResumeService({ transact: db.transact }).requestAttendanceResume(t.org, t.actor, randomUUID(),
      { conversationId: t.conversation, expectedControlRevision: 1, expectedOwnerRevision: 0, target: { kind: 'NEW_SESSION' } })).rejects.toMatchObject({ code: 'NICO_TAKEOVER_OPEN' });
    await expect(db.transact(t.org, tx => tx.query("UPDATE messaging_conversations SET mode='BOT' WHERE organization_id=$1 AND id=$2", [t.org, t.conversation])))
      .rejects.toMatchObject({ constraint: 'nico_takeover_open' });
  });
  it('cancels by request identity before a late begin, without changing BOT', async () => {
    const t = await fixture();
    const canceled = await t.service.cancel(t.principal, t.integration, 11, t.input);
    expect(canceled).toMatchObject({ state: 'CANCELED', mode: 'BOT' });
    expect(await t.service.start(t.principal, t.integration, 11, t.input)).toEqual(canceled);
    await expect(t.service.complete(t.principal, t.integration, 11, canceled.id, 23)).rejects.toMatchObject({ status: 409 });
  });
  it('allows NONE and already HUMAN, and cancellation preserves the confirmed pause', async () => {
    const t = await fixture();
    await db.database.pool.query("UPDATE messaging_conversations SET mode='HUMAN' WHERE id=$1", [t.conversation]);
    expect(await t.service.start(t.principal, t.integration, 11, t.input)).toMatchObject({ state: 'PAUSED' });
    expect(await t.service.cancel(t.principal, t.integration, 11, t.input)).toMatchObject({ state: 'CANCELED', mode: 'HUMAN' });
  });
  it('requires the exact authenticated outgoing User receipt, rejects history and completes once', async () => {
    const t = await fixture(), op = await t.service.start(t.principal, t.integration, 11, t.input);
    const message = { id: 23, account_id: 7, inbox_id: 9, conversation_id: 11, message_type: 'outgoing', private: false,
      content: t.content, sender: { id: 42, type: 'user' }, content_attributes: {}, created_at: Date.now() / 1000 };
    t.canonical.mockResolvedValue(message as never);
    await expect(t.service.complete(t.principal, t.integration, 11, op.id, 23)).rejects.toMatchObject({ status: 409 });
    t.canonical.mockResolvedValue({ ...message, content_attributes: { jrc_nico_takeover: { takeoverId: op.id, requestId: op.requestId, fingerprint: op.fingerprint } } } as never);
    expect(await t.service.complete(t.principal, t.integration, 11, op.id, 23)).toMatchObject({ state: 'COMPLETED', mode: 'HUMAN' });
    expect(await t.service.complete(t.principal, t.integration, 11, op.id, 23)).toMatchObject({ state: 'COMPLETED' });
    await expect(t.service.complete(t.principal, t.integration, 11, op.id, 24)).rejects.toMatchObject({ status: 409 });
    expect(await t.service.cancel(t.principal, t.integration, 11, t.input)).toMatchObject({ state: 'COMPLETED' });
  });
  it('revalidates scope after canonical HTTP and leaves the fence on context change', async () => {
    const t = await fixture(), op = await t.service.start(t.principal, t.integration, 11, t.input);
    t.canonical.mockImplementation(async () => {
      await db.database.pool.query('UPDATE chatwoot_accounts SET credential_version=credential_version+1 WHERE organization_id=$1', [t.org]);
      return { id: 23, account_id: 7, inbox_id: 9, conversation_id: 11, message_type: 'outgoing', private: false, content: t.content,
        sender: { id: 42, type: 'user' }, content_attributes: { jrc_nico_takeover: { takeoverId: op.id, requestId: op.requestId, fingerprint: op.fingerprint } } } as never;
    });
    await expect(t.service.complete(t.principal, t.integration, 11, op.id, 23)).rejects.toMatchObject({ status: 409 });
    expect((await db.database.pool.query('SELECT state FROM nico_takeover_operations WHERE id=$1', [op.id])).rows[0].state).toBe('OPEN');
  });
  it('isolates equal remote IDs across Accounts and serialized requests across operators', async () => {
    const a = await fixture(), b = await fixture();
    const op = await a.service.start(a.principal, a.integration, 11, a.input);
    await expect(b.service.get(b.principal, b.integration, 11, op.id)).rejects.toMatchObject({ status: 404 });
    expect((await db.transact(b.org, tx => tx.query('SELECT 1 FROM nico_takeover_operations WHERE id=$1', [op.id]))).rowCount).toBe(0);
    await expect(a.service.start(a.principal, a.integration, 11, { ...a.input, requestId: randomUUID(), expectedAttendanceRevision: 1, expectedControlRevision: 1 }))
      .rejects.toMatchObject({ status: 409 });
  });
  it('serializes begin against an irreversible cancellation with a tombstone', async () => {
    const t = await fixture();
    const results = await Promise.all([
      t.service.start(t.principal, t.integration, 11, t.input),
      t.service.cancel(t.principal, t.integration, 11, t.input),
    ]);
    const op = await t.service.get(t.principal, t.integration, 11, results[0].id);
    expect(op.state).toBe('CANCELED');
    expect((await db.database.pool.query('SELECT 1 FROM nico_takeover_operations WHERE organization_id=$1', [t.org])).rowCount).toBe(1);
    expect((await t.service.start(t.principal, t.integration, 11, t.input)).state).toBe('CANCELED');
  });
  it('refuses a changed contact mapping while allowing irreversible cancellation', async () => {
    const t = await fixture();
    const op = await t.service.start(t.principal, t.integration, 11, t.input);
    await db.database.pool.query('UPDATE chatwoot_conversations SET contact_id=14 WHERE organization_id=$1', [t.org]);
    expect(await t.service.get(t.principal, t.integration, 11, op.id)).toMatchObject({ state: 'STALE', remoteContactId: 14 });
    await expect(t.service.complete(t.principal, t.integration, 11, op.id, 23)).rejects.toMatchObject({ status: 409 });
    expect(await t.service.cancel(t.principal, t.integration, 11, t.input)).toMatchObject({ state: 'CANCELED', mode: 'HUMAN' });
  });
  it('completes after its own human callbacks increment attendance revisions', async () => {
    const t = await fixture(), op = await t.service.start(t.principal, t.integration, 11, t.input);
    await db.database.pool.query('UPDATE messaging_conversations SET attendance_revision=attendance_revision+1 WHERE id=$1', [t.conversation]);
    t.canonical.mockResolvedValue({ id: 23, account_id: 7, inbox_id: 9, conversation_id: 11, message_type: 'outgoing', private: false,
      content: t.content, sender: { id: 42, type: 'user' }, content_attributes: { jrc_nico_takeover: { takeoverId: op.id, requestId: op.requestId, fingerprint: op.fingerprint } } } as never);
    expect(await t.service.complete(t.principal, t.integration, 11, op.id, 23)).toMatchObject({ state: 'COMPLETED', mode: 'HUMAN' });
  });
  it('rejects other senders, changed approved content and a Message reused by another operation', async () => {
    const t = await fixture(), first = await t.service.start(t.principal, t.integration, 11, t.input);
    const message = { id: 23, account_id: 7, inbox_id: 9, conversation_id: 11, message_type: 'outgoing', private: false,
      content: t.content, sender: { id: 42, type: 'user' }, content_attributes: { jrc_nico_takeover: { takeoverId: first.id, requestId: first.requestId, fingerprint: first.fingerprint } } };
    for (const change of [{ sender: { id: 43, type: 'user' } }, { sender: { id: 42, type: 'agent_bot' } }, { private: true }, { content: 'Unapproved' }]) {
      t.canonical.mockResolvedValue({ ...message, ...change } as never);
      await expect(t.service.complete(t.principal, t.integration, 11, first.id, 23)).rejects.toMatchObject({ code: 'NICO_TAKEOVER_RECEIPT_MISMATCH' });
    }
    t.canonical.mockResolvedValue(message as never);
    await t.service.complete(t.principal, t.integration, 11, first.id, 23);
    const second = await t.service.start(t.principal, t.integration, 11, { ...t.input, requestId: randomUUID(), expectedAttendanceRevision: 1, expectedControlRevision: 1 });
    t.canonical.mockResolvedValue({ ...message, content_attributes: { jrc_nico_takeover: { takeoverId: second.id, requestId: second.requestId, fingerprint: second.fingerprint } } } as never);
    await expect(t.service.complete(t.principal, t.integration, 11, second.id, 23)).rejects.toMatchObject({ code: 'NICO_TAKEOVER_RECEIPT_CONFLICT', status: 409 });
    expect((await db.database.pool.query('SELECT state FROM nico_takeover_operations WHERE id=$1', [second.id])).rows[0].state).toBe('OPEN');
  });
  it('keeps UNKNOWN transport effects draining until a durable result is reconciled', async () => {
    const t = await fixture(), message = randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state)
      VALUES($1,$2,$3,$4,'OUTGOING','AUTOMATION','{"type":"TEXT","text":"Synthetic automatic reply"}','UNKNOWN')`, [message, t.org, t.channel, t.conversation]);
    const op = await t.service.start(t.principal, t.integration, 11, t.input);
    expect(op.state).toBe('DRAINING');
    await expect(t.service.complete(t.principal, t.integration, 11, op.id, 23)).rejects.toMatchObject({ code: 'NICO_TAKEOVER_NOT_PAUSED' });
    await db.database.pool.query("UPDATE messaging_messages SET state='DELIVERED',upstream_message_id='synthetic-ack' WHERE id=$1", [message]);
    expect((await t.service.get(t.principal, t.integration, 11, op.id)).state).toBe('PAUSED');
  });
  it('cancels a resume before remote dispatch but preserves a dispatched uncertain resume', async () => {
    for (const phase of ['PREPARED', 'CLEAR_AGENT']) {
      const t = await fixture(), resumeId = randomUUID();
      await db.database.pool.query(`INSERT INTO attendance_resume_operations(organization_id,id,channel_id,conversation_id,actor_id,idempotency_key,request_hash,snapshot,phase)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [t.org, resumeId, t.channel, t.conversation, t.actor, randomUUID(), 'a'.repeat(64),
        JSON.stringify({ channelId: t.channel, conversationId: t.conversation }), phase]);
      const op = await t.service.start(t.principal, t.integration, 11, t.input);
      expect(op.state).toBe(phase === 'PREPARED' ? 'PAUSED' : 'DRAINING');
      expect((await db.database.pool.query('SELECT state FROM attendance_resume_operations WHERE id=$1', [resumeId])).rows[0].state)
        .toBe(phase === 'PREPARED' ? 'CANCELED' : 'PENDING');
    }
  });
  it('preserves tenant RLS, immutable receipts and app-role structural readiness', async () => {
    const t = await fixture(), op = await t.service.start(t.principal, t.integration, 11, t.input);
    expect(await db.transact(t.org, tx => probeRequiredRuntimeSchema(sql => tx.query(sql)))).toBe(true);
    await expect(db.transact(t.org, tx => tx.query("UPDATE nico_takeover_operations SET fingerprint=$2 WHERE id=$1", [op.id, 'b'.repeat(64)])))
      .rejects.toMatchObject({ constraint: 'nico_takeover_immutable' });
    await expect(db.transact(t.org, tx => tx.query('DELETE FROM nico_takeover_operations WHERE id=$1', [op.id])))
      .rejects.toMatchObject({ code: '42501' });
    const client = await db.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE messaging_conversations DISABLE TRIGGER nico_takeover_prevent_resume');
      await client.query('SET LOCAL ROLE jrc_app');
      expect(await probeRequiredRuntimeSchema(sql => client.query(sql))).toBe(false);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('freezes owner and binding changes between PAUSED and Message creation', async () => {
    const t = await fixture(), binding = randomUUID();
    await db.database.pool.query('INSERT INTO attendance_owners(organization_id,channel_id) VALUES($1,$2)', [t.org,t.channel]);
    await db.database.pool.query('INSERT INTO automation_bindings(organization_id,id,channel_id,automation_id,version) VALUES($1,$2,$3,$4,1)', [t.org,binding,t.channel,t.automation]);
    await t.service.start(t.principal,t.integration,11,t.input);
    await expect(db.transact(t.org,tx=>tx.query("UPDATE attendance_owners SET executor='EXTERNAL',revision=revision+1 WHERE organization_id=$1 AND channel_id=$2",[t.org,t.channel])))
      .rejects.toMatchObject({constraint:'nico_takeover_open'});
    await expect(db.transact(t.org,tx=>tx.query("UPDATE automation_bindings SET status='PAUSED',revision=revision+1 WHERE organization_id=$1 AND id=$2",[t.org,binding])))
      .rejects.toMatchObject({constraint:'nico_takeover_open'});
    await t.service.cancel(t.principal,t.integration,11,t.input);
    await expect(db.transact(t.org,tx=>tx.query("UPDATE attendance_owners SET executor='EXTERNAL',revision=revision+1 WHERE organization_id=$1 AND channel_id=$2",[t.org,t.channel])))
      .resolves.toMatchObject({rowCount:1});
  });
  it('refuses an external executor before changing attendance', async () => {
    const t=await fixture();
    await db.database.pool.query("INSERT INTO attendance_owners(organization_id,channel_id,executor) VALUES($1,$2,'EXTERNAL')",[t.org,t.channel]);
    await expect(t.service.start(t.principal,t.integration,11,t.input)).rejects.toMatchObject({code:'NICO_TAKEOVER_EXECUTOR_UNSUPPORTED'});
  });
  it('serializes native cutover admission before remote dispatch against NICO', async () => {
    const insert = (t: Awaited<ReturnType<typeof fixture>>) => db.transact(t.org,tx=>tx.query(`INSERT INTO flow_executor_cutovers(organization_id,integration_id,channel_id,
      host_kind,profile_revision,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,expected_owner_revision)
      VALUES($1,$2,$3,'STOCK',1,1,7,9,1,1,0)`,[t.org,t.integration,t.channel]));
    const a=await fixture();
    await insert(a);
    await expect(a.service.start(a.principal,a.integration,11,a.input)).rejects.toMatchObject({code:'NICO_TAKEOVER_EXECUTOR_UNSETTLED'});
    expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE id=$1',[a.conversation])).rows[0].mode).toBe('BOT');
    const b=await fixture();
    await b.service.start(b.principal,b.integration,11,b.input);
    await expect(insert(b)).rejects.toMatchObject({constraint:'nico_takeover_open'});
  });
  it('blocks legacy remote provisioning before either side can dispatch', async () => {
    const insert=async(t: Awaited<ReturnType<typeof fixture>>) => {
      const flow=randomUUID();
      await db.database.pool.query("INSERT INTO flows(id,organization_id,name,graph) VALUES($1,$2,'Synthetic','{}')",[flow,t.org]);
      return db.transact(t.org,tx=>tx.query(`INSERT INTO flow_chatwoot_bindings(organization_id,flow_id,inbox_id,account_id,destination_revision,credential_version,
        feature_revision,name,channel_type,status,operation_state) VALUES($1,$2,9,7,1,1,1,'Synthetic','Channel::Api','UNKNOWN','UNKNOWN')`,[t.org,flow]));
    };
    const a=await fixture();await insert(a);
    await expect(a.service.start(a.principal,a.integration,11,a.input)).rejects.toMatchObject({code:'NICO_TAKEOVER_EXECUTOR_UNSETTLED'});
    const b=await fixture();await b.service.start(b.principal,b.integration,11,b.input);
    await expect(insert(b)).rejects.toMatchObject({constraint:'nico_takeover_open'});
  });
  it.each(['PREPARED','OPEN_DISPATCHED','ASSIGNMENT_DISPATCHED'])('handles handoff phase %s independently of outbox state', async phase => {
    const t=await fixture(), e=await execution(t,phase==='PREPARED'?'UNKNOWN':'SENT'), id=randomUUID();
    await db.database.pool.query(`INSERT INTO attendance_handoff_operations(organization_id,id,outbox_id,execution_id,channel_id,conversation_id,integration_id,lease_token,snapshot,phase,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'UNKNOWN')`,[t.org,id,e.outbox,e.execution,t.channel,t.conversation,t.integration,randomUUID(),JSON.stringify({scope:t.scope}),phase]);
    const op=await t.service.start(t.principal,t.integration,11,t.input);
    expect(op.state).toBe(phase==='PREPARED'?'PAUSED':'DRAINING');
    const stored=(await db.database.pool.query('SELECT phase,state FROM attendance_handoff_operations WHERE id=$1',[id])).rows[0];
    expect(stored).toEqual({phase,state:phase==='PREPARED'?'ACTION_REQUIRED':'UNKNOWN'});
  });
  it.each(['PREPARED','DISPATCHED','UNKNOWN'])('handles media effect %s independently of delivered transport rows', async state => {
    const t=await fixture(),e=await execution(t,state==='PREPARED'?'SENDING':'SENT');
    await db.database.pool.query(`INSERT INTO automation_conversation_effects(organization_id,outbox_id,channel_id,conversation_id,execution_id,automation_id,version,operation,profile,state,owner_revision,control_revision)
      VALUES($1,$2,$3,$4,$5,$6,1,'media','CENTRAL',$7,0,0)`,[t.org,e.outbox,t.channel,t.conversation,e.execution,t.automation,state]);
    const op=await t.service.start(t.principal,t.integration,11,t.input);
    expect(op.state).toBe(state==='PREPARED'?'PAUSED':'DRAINING');
    expect((await db.database.pool.query('SELECT state FROM automation_conversation_effects WHERE outbox_id=$1',[e.outbox])).rows[0].state)
      .toBe(state==='PREPARED'?'REJECTED':state);
  });
  it.each(['RESERVED','DISPATCHED','UNKNOWN'])('handles central mirror %s without relying on message state', async state => {
    const t=await fixture(),e=await execution(t), message=await deliveredMessage(t);
    await db.database.pool.query(`INSERT INTO chatwoot_mirror_attempts(organization_id,channel_id,integration_id,destination_revision,account_id,inbox_id,conversation_id,
      remote_conversation_id,cycle,message_id,lease_token,state,transport,origin,credential_version,owner_revision,control_revision,execution_id,automation_id,version,dispatch_proof,sender_id)
      VALUES($1,$2,$3,1,7,9,$4,11,1,$5,$6,$7,'CENTRAL_TRANSPORT',$8,1,1,1,$9,$10,1,$11,42)`,
      [t.org,t.channel,t.integration,t.conversation,message,randomUUID(),state,`https://${t.org}.example.test`,e.execution,t.automation,'a'.repeat(43)]);
    const op=await t.service.start(t.principal,t.integration,11,t.input);
    expect(op.state).toBe(state==='RESERVED'?'PAUSED':'DRAINING');
    expect((await db.database.pool.query('SELECT state FROM chatwoot_mirror_attempts WHERE message_id=$1',[message])).rows[0].state)
      .toBe(state==='RESERVED'?'REJECTED':state);
  });
  it.each(['DISPATCHED','UNKNOWN'])('preserves QR %s despite a delivered message row', async state => {
    const t=await fixture(),message=await deliveredMessage(t),id=randomUUID();
    await db.database.pool.query(`INSERT INTO qr_dispatch_attempts(organization_id,id,channel_id,conversation_id,message_id,lease_token,lease_expires_at,state)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 minute',$7)`,[t.org,id,t.channel,t.conversation,message,randomUUID(),state]);
    const op=await t.service.start(t.principal,t.integration,11,t.input);
    expect(op.state).toBe('DRAINING');
    await db.database.pool.query("UPDATE qr_dispatch_attempts SET state='CONFIRMED',provider_message_id='synthetic-proof' WHERE id=$1",[id]);
    expect((await t.service.get(t.principal,t.integration,11,op.id)).state).toBe('PAUSED');
  });
  it.each(['central','qr'])('blocks unresolved %s observations with no message/outbox in flight', async source => {
    const t=await fixture();
    if(source==='qr') await db.database.pool.query(`INSERT INTO qr_outbound_observations(organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at)
      VALUES($1,$2,$3,'synthetic','{}',now())`,[t.org,t.channel,t.conversation]);
    else await db.database.pool.query(`INSERT INTO chatwoot_attendance_observations(organization_id,integration_id,channel_id,destination_revision,credential_revision,
      account_id,inbox_id,remote_conversation_id,conversation_id,event_key,event,disposition)
      VALUES($1,$2,$3,1,1,7,9,11,$4,'synthetic','{}','RECONCILE')`,[t.org,t.integration,t.channel,t.conversation]);
    expect((await t.service.start(t.principal,t.integration,11,t.input)).state).toBe('DRAINING');
  });
});
