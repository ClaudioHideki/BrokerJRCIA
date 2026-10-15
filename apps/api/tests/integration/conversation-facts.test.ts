import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { readLocalConversationContext } from '../../src/modules/messaging/conversation-facts.js';

describe('private standalone conversation projection through jrc_app', () => {
  let lab: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { lab = await attendanceDatabase(); }, 60000);
  afterAll(async () => { await lab?.dispose(); });
  async function seed(central = false) {
    const tenant = await seedAttendanceTenant(lab.database, central), label = randomUUID(), attribute = randomUUID();
    await lab.transact(tenant.org, async tx => {
      for (const [id, kind, key, name, definition] of [[label, 'LABEL', 'finance', 'Financeiro', null],
        [attribute, 'ATTRIBUTE', 'active', 'Ativo', { valueType: 'boolean', maxLength: 4096, allowedValues: [] }]] as const) {
        await tx.query(`insert into automation_action_resources(organization_id,id,channel_id,source,kind,name,key,revision,definition)
          values($1,$2,$3,'LOCAL',$4,$5,$6,$7,$8::jsonb)`, [tenant.org, id, tenant.channel, kind, name, key, 'a'.repeat(64), definition === null ? null : JSON.stringify(definition)]);
      }
      await tx.query(`insert into automation_conversation_state(organization_id,channel_id,conversation_id,labels,attributes,status,revision)
        values($1,$2,$3,$4::jsonb,'{"active":false,"balance":0}','RESOLVED',9007199254740993)`, [tenant.org, tenant.channel, tenant.conversation, JSON.stringify([label])]);
      await tx.query(`insert into automation_private_notes(organization_id,id,channel_id,conversation_id,origin_outbox_id,body)
        values($1,$2,$3,$4,$5,'Nota sintética privada')`, [tenant.org, randomUUID(), tenant.channel, tenant.conversation, randomUUID()]);
    });
    return tenant;
  }
  it('reads named labels, typed false/zero, resolution and exact int8 revision without creating a message', async () => {
    const t = await seed();
    const before = (await lab.database.pool.query('select count(*) from messaging_messages where organization_id=$1', [t.org])).rows[0].count;
    const facts = await lab.transact(t.org, tx => readLocalConversationContext(tx, t.org, t.channel, t.conversation));
    expect(facts).toMatchObject({ scope: { organizationId: t.org, channelId: t.channel, conversationId: t.conversation },
      revision: '9007199254740993', status: 'RESOLVED', labels: [{ name: 'Financeiro' }],
      attributes: expect.arrayContaining([{ key: 'active', name: 'Ativo', value: false }, { key: 'balance', name: 'balance', value: 0 }]),
      privateNotes: [{ text: 'Nota sintética privada' }], notesTruncated: false });
    expect((await lab.database.pool.query('select count(*) from messaging_messages where organization_id=$1', [t.org])).rows[0].count).toBe(before);
  });
  it('does not expose another tenant or box even when the caller knows the conversation UUID', async () => {
    const a = await seed(), b = await seed();
    await expect(lab.transact(a.org, tx => readLocalConversationContext(tx, b.org, b.channel, b.conversation))).resolves.toBeUndefined();
    await expect(lab.transact(a.org, tx => readLocalConversationContext(tx, a.org, b.channel, a.conversation))).resolves.toBeUndefined();
  });
  it('never substitutes local notes for a centrally connected conversation', async () => {
    const t = await seed(true);
    await expect(lab.transact(t.org, tx => readLocalConversationContext(tx, t.org, t.channel, t.conversation))).resolves.toBeUndefined();
  });
  it('bounds private history to the latest 100 notes and reports older records explicitly', async () => {
    const t = await seed();
    await lab.transact(t.org, tx => tx.query(`insert into automation_private_notes(organization_id,id,channel_id,conversation_id,origin_outbox_id,body,created_at)
      select $1,gen_random_uuid(),$2,$3,gen_random_uuid(),'Nota antiga '||n,clock_timestamp()-interval '1 day'-n*interval '1 second' from generate_series(1,101) n`, [t.org, t.channel, t.conversation]));
    const facts = await lab.transact(t.org, tx => readLocalConversationContext(tx, t.org, t.channel, t.conversation));
    expect(facts?.privateNotes).toHaveLength(100); expect(facts?.notesTruncated).toBe(true);
    expect(facts?.privateNotes[0]?.text).toBe('Nota sintética privada');
  });
});
