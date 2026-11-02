import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { chatwootEnvironment, type ChatwootOptions } from '../../src/modules/integrations/chatwoot-service.js';
import { createChatwootWorker } from '../../src/modules/integrations/chatwoot-worker.js';

describe('Chatwoot mirror isolation around uncertain remote writes', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 60_000);
  afterAll(async () => { await db?.dispose(); });

  async function fixture() {
    const t = await seedAttendanceTenant(db.database);
    const posts: Record<string, unknown>[] = [];
    const options: ChatwootOptions = {
      baseUrl: `https://${t.org}.example.test`, publicOrigin: 'https://broker.example.test',
      encryptionKey: Buffer.alloc(32, 6).toString('base64'), transact: db.transact,
      resolveIntegration: async id => id === t.integration ? t.org : undefined,
      async fetch(input, init) {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/messages') && init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return Response.json({ id: 900 + posts.length });
        }
        throw new Error(`Unexpected fixture request ${init?.method ?? 'GET'} ${path}`);
      },
    };
    const vault = chatwootEnvironment(options).vault;
    await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',
      [t.org, vault.encrypt(`${t.org}:chatwoot-account`, 'synthetic-token')]);
    await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,41,'synthetic-source',51)`, [t.org, t.integration, t.conversation]);
    return { ...t, options, posts };
  }

  async function conversation(t: Awaited<ReturnType<typeof fixture>>, remote: number, contactId?: string, mapped = true) {
    const contact = contactId ?? (await db.database.pool.query(`INSERT INTO messaging_contacts(organization_id,external_id)
      VALUES($1,$2) RETURNING id`, [t.org, `synthetic-${remote}`])).rows[0].id;
    const id = randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id,remote_conversation_key)
      VALUES($1,$2,$3,$4,$5)`, [id, t.org, t.channel, contact, contactId ? `chatwoot-cycle:${t.integration}:${remote}` : null]);
    if (mapped) await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [t.org, t.integration, id, remote + 100, `source-${remote}`, remote]);
    return id;
  }

  async function secondConnection(t: Awaited<ReturnType<typeof fixture>>) {
    const channel = randomUUID(), integration = randomUUID(), id = randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_channels(id,organization_id,provider_account_id,phone_number_id,waba_id,credential_reference)
      SELECT $1,organization_id,provider_account_id,$2,waba_id,credential_reference FROM messaging_channels WHERE organization_id=$3 AND id=$4`,
      [channel, `synthetic-${channel}`, t.org, t.channel]);
    await db.database.pool.query(`INSERT INTO chatwoot_connections(id,organization_id,channel_id,inbox_id,name,status)
      VALUES($1,$2,$3,10,'Second synthetic connection','READY')`, [integration, t.org, channel]);
    const other = { ...t, channel, integration, conversation: id };
    await db.database.pool.query(`INSERT INTO messaging_conversations(id,organization_id,channel_id,contact_id)
      SELECT $1,$2,$3,contact_id FROM messaging_conversations WHERE organization_id=$2 AND id=$4`, [id, t.org, channel, t.conversation]);
    await db.database.pool.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id)
      VALUES($1,$2,$3,42,'second-synthetic-source',61)`, [t.org, integration, id]);
    return other;
  }

  async function incoming(t: Awaited<ReturnType<typeof fixture>>, conversationId: string) {
    const message = (await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state)
      VALUES($1,$2,$3,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic inbound"}','DELIVERED') RETURNING id`,
      [t.org, t.channel, conversationId])).rows[0].id as string;
    const job = (await db.database.pool.query('SELECT id FROM integration_jobs WHERE organization_id=$1 AND message_id=$2', [t.org, message])).rows[0].id as string;
    return { message, job };
  }

  async function uncertain(t: Awaited<ReturnType<typeof fixture>>) {
    const initial = await incoming(t, t.conversation);
    await db.database.pool.query(`UPDATE integration_jobs SET status='UNKNOWN',attempts=1,
      payload='{"operation":"SEND_MESSAGE","conversationId":51}',last_error='CHATWOOT_OUTCOME_UNKNOWN' WHERE id=$1`, [initial.job]);
    const attempt = (await db.database.pool.query(`INSERT INTO chatwoot_mirror_attempts(organization_id,channel_id,integration_id,destination_revision,
      account_id,inbox_id,conversation_id,remote_conversation_id,cycle,message_id,job_id,lease_token,state)
      VALUES($1,$2,$3,1,7,9,$4,51,1,$5,$6,$7,'UNKNOWN') RETURNING id`,
      [t.org, t.channel, t.integration, t.conversation, initial.message, initial.job, randomUUID()])).rows[0].id as string;
    return { ...initial, attempt };
  }

  it('delivers another contact without retrying or clearing the uncertain mirror', async () => {
    const t = await fixture(), blocked = await uncertain(t);
    const next = await incoming(t, await conversation(t, 52));
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1', [next.job])).rows[0].status).toBe('SUCCEEDED');
    expect((await db.database.pool.query('SELECT status,attempts,last_error FROM integration_jobs WHERE id=$1', [blocked.job])).rows[0])
      .toEqual({ status: 'UNKNOWN', attempts: 1, last_error: 'CHATWOOT_OUTCOME_UNKNOWN' });
    expect((await db.database.pool.query('SELECT state,remote_message_id FROM chatwoot_mirror_attempts WHERE id=$1', [blocked.attempt])).rows[0])
      .toEqual({ state: 'UNKNOWN', remote_message_id: null });
    expect(t.posts).toEqual([expect.objectContaining({ message_type: 'incoming', content_attributes: { jrc_broker_message_id: next.message } })]);
  });

  it('keeps queued replies to WhatsApp stopped while another inbound contact is mirrored', async () => {
    const t = await fixture();
    await uncertain(t);
    const reply = (await db.database.pool.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,payload,created_at)
      VALUES($1,$2,'CHATWOOT_REPLY','old-public-reply','{"messageId":777,"conversationId":51,"content":{"type":"TEXT","text":"Old reply"}}',now()-interval '2 days') RETURNING id`,
      [t.org, t.integration])).rows[0].id;
    const next = await incoming(t, await conversation(t, 52));
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1', [next.job])).rows[0].status).toBe('SUCCEEDED');
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [reply])).rows[0])
      .toEqual({ status: 'PENDING', attempts: 0 });
    expect((await db.database.pool.query('SELECT message_id FROM messaging_outbox WHERE organization_id=$1', [t.org])).rows).toEqual([]);
  });

  it.each(['SEND_MESSAGE', 'CREATE_CONTACT', 'LINK_CONTACT', 'CREATE_CONVERSATION'])
    ('keeps the same contact fenced across physical cycles after an uncertain %s', async operation => {
      const t = await fixture(), blocked = await uncertain(t);
      await db.database.pool.query('UPDATE integration_jobs SET payload=payload||jsonb_build_object(\'operation\',$2::text) WHERE id=$1', [blocked.job, operation]);
      const contact = (await db.database.pool.query('SELECT contact_id FROM messaging_conversations WHERE id=$1', [t.conversation])).rows[0].contact_id;
      const sameCycle = await incoming(t, t.conversation);
      const laterCycle = await incoming(t, await conversation(t, 53, contact));
      const unrelated = await incoming(t, await conversation(t, 52));
      await createChatwootWorker(t.options).runOnce(t.org);
      expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1', [unrelated.job])).rows[0].status).toBe('SUCCEEDED');
      expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [[sameCycle.job, laterCycle.job]])).rows)
        .toEqual([{ status: 'PENDING', attempts: 0 }, { status: 'PENDING', attempts: 0 }]);
      expect(t.posts).toHaveLength(1);
    });

  it('keeps an uncertain write without canonical message context as an integration-wide barrier', async () => {
    const t = await fixture(), blocked = await uncertain(t);
    await db.database.pool.query('UPDATE integration_jobs SET message_id=NULL WHERE id=$1', [blocked.job]);
    const next = await incoming(t, await conversation(t, 52));
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [next.job])).rows[0])
      .toEqual({ status: 'PENDING', attempts: 0 });
    expect(t.posts).toEqual([]);
  });

  it('does not treat a message from another channel as the uncertain contact context', async () => {
    const t = await fixture(), blocked = await uncertain(t), other = await secondConnection(t);
    const foreign = await incoming(other, other.conversation);
    await db.database.pool.query("UPDATE chatwoot_connections SET status='DISABLED' WHERE id=$1", [other.integration]);
    await db.database.pool.query('UPDATE integration_jobs SET message_id=$2 WHERE id=$1', [blocked.job, foreign.message]);
    const next = await incoming(t, await conversation(t, 52));
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [next.job])).rows[0])
      .toEqual({ status: 'PENDING', attempts: 0 });
    expect(t.posts).toEqual([]);
  });

  it('skips a pending mirror that references another channel and delivers the valid mirror', async () => {
    const t = await fixture();
    await uncertain(t);
    const other = await secondConnection(t), foreign = await incoming(other, other.conversation);
    await db.database.pool.query("UPDATE chatwoot_connections SET status='DISABLED' WHERE id=$1", [other.integration]);
    const corrupt = (await db.database.pool.query(`INSERT INTO integration_jobs(organization_id,integration_id,kind,dedupe_key,message_id)
      VALUES($1,$2,'MIRROR_MESSAGE','wrong-channel',$3) RETURNING id`, [t.org, t.integration, foreign.message])).rows[0].id;
    const next = await incoming(t, await conversation(t, 52));
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1', [next.job])).rows[0].status).toBe('SUCCEEDED');
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [corrupt])).rows[0])
      .toEqual({ status: 'PENDING', attempts: 0 });
    expect(t.posts).toHaveLength(1);
  });

  it('does not let an older connection with only fenced work starve another connection', async () => {
    const t = await fixture();
    await uncertain(t);
    const fenced = await incoming(t, t.conversation), other = await secondConnection(t);
    const next = await incoming(other, other.conversation);
    await db.database.pool.query("UPDATE chatwoot_connections SET updated_at=now()-interval '2 days' WHERE id=$1", [t.integration]);
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1', [next.job])).rows[0].status).toBe('SUCCEEDED');
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [fenced.job])).rows[0])
      .toEqual({ status: 'PENDING', attempts: 0 });
  });

  it('keeps another tenant independent without reading or claiming its uncertain job', async () => {
    const a = await fixture(), blocked = await uncertain(a), b = await fixture();
    const next = await incoming(b, b.conversation);
    await createChatwootWorker(b.options).runOnce(b.org);
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1', [next.job])).rows[0].status).toBe('SUCCEEDED');
    expect((await db.transact(b.org, tx => tx.query('SELECT id FROM integration_jobs WHERE id=$1', [blocked.job]))).rows).toEqual([]);
    expect(a.posts).toEqual([]);
  });

  it('turns an expired mirror lease into uncertainty while allowing an unrelated inbound contact', async () => {
    const t = await fixture(), blocked = await uncertain(t);
    await db.database.pool.query(`UPDATE integration_jobs SET status='RUNNING',lease_token=$2,lease_expires_at=now()-interval '1 second'
      WHERE id=$1`, [blocked.job, randomUUID()]);
    const next = await incoming(t, await conversation(t, 52));
    await createChatwootWorker(t.options).runOnce(t.org);
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=$1', [next.job])).rows[0].status).toBe('SUCCEEDED');
    expect((await db.database.pool.query('SELECT status,last_error FROM integration_jobs WHERE id=$1', [blocked.job])).rows[0])
      .toEqual({ status: 'UNKNOWN', last_error: 'WORKER_LEASE_EXPIRED' });
  });

  it('serializes concurrent workers through contact creation and retains the uncertain barrier', async () => {
    const t = await fixture(), blocked = await uncertain(t);
    const first = await incoming(t, await conversation(t, 52, undefined, false));
    const second = await incoming(t, await conversation(t, 53, undefined, false));
    let release!: () => void, entered!: () => void, contacts = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const contactStarted = new Promise<void>(resolve => { entered = resolve; });
    const options: ChatwootOptions = { ...t.options, async fetch(input, init) {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/contacts/search')) return Response.json({ payload: [] });
      if (path.endsWith('/contacts') && init?.method === 'POST') {
        contacts++;
        if (contacts === 1) { entered(); await waiting; }
        return Response.json({ payload: { contact: { id: 100 + contacts } } });
      }
      if (path.endsWith('/contact_inboxes')) return Response.json({ source_id: `source-${contacts}` });
      if (path.endsWith('/conversations')) return Response.json({ id: 100 + contacts });
      return t.options.fetch!(input, init);
    } };
    const worker = createChatwootWorker(options), rival = createChatwootWorker(options);
    const running = [worker.runOnce(t.org), rival.runOnce(t.org)];
    try {
      expect(await Promise.race([contactStarted.then(() => true), Promise.all(running).then(() => false)])).toBe(true);
      await Promise.race(running);
      expect(contacts).toBe(1);
      expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [first.job])).rows[0])
        .toEqual({ status: 'RUNNING', attempts: 1 });
      expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [second.job])).rows[0])
        .toEqual({ status: 'PENDING', attempts: 0 });
    } finally { release(); }
    await Promise.all(running);
    await worker.runOnce(t.org);
    expect((await db.database.pool.query('SELECT status FROM integration_jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [[first.job, second.job]])).rows)
      .toEqual([{ status: 'SUCCEEDED' }, { status: 'SUCCEEDED' }]);
    expect((await db.database.pool.query('SELECT status,attempts FROM integration_jobs WHERE id=$1', [blocked.job])).rows[0])
      .toEqual({ status: 'UNKNOWN', attempts: 1 });
    expect(contacts).toBe(2);
    expect(t.posts).toHaveLength(2);
  });
});
