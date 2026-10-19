import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {requireTestDatabaseAdminUrl} from './helpers/postgres.js';
import {withGlobalRoleLock} from './helpers/global-role-lock.js';
import {probeRequiredRuntimeSchema,RUNTIME_SCHEMA_BASELINE} from '../../src/db/runtime-schema.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>,tenant:Awaited<ReturnType<typeof seedAttendanceTenant>>,historical:Record<string,unknown>,oldMessage:Record<string,unknown>,oldOutbox:Record<string,unknown>,oldObservation:Record<string,unknown>;
beforeAll(async()=>{
  db=await attendanceDatabase();tenant=await seedAttendanceTenant(db.database,false);
  historical=(await db.database.pool.query('SELECT * FROM messaging_conversations WHERE id=$1',[tenant.conversation])).rows[0]!;
  oldMessage=(await db.database.pool.query(`INSERT INTO messaging_messages(organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
    VALUES($1,$2,$3,'OUTGOING','OPERATOR','{"type":"TEXT","text":"Historical individual row"}','ACCEPTED','historical-individual','historical-hash') RETURNING *`,[tenant.org,tenant.channel,tenant.conversation])).rows[0]!;
  oldOutbox=(await db.database.pool.query('INSERT INTO messaging_outbox(organization_id,message_id,lease_token,lease_expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'1 minute\') RETURNING *',[tenant.org,oldMessage.id,randomUUID()])).rows[0]!;
  oldObservation=(await db.database.pool.query(`INSERT INTO qr_outbound_observations(organization_id,channel_id,conversation_id,provider_message_id,content,occurred_at)
    VALUES($1,$2,$3,'historical-unresolved-id','{"type":"TEXT","text":"Historical unresolved ledger"}',clock_timestamp()) RETURNING *`,[tenant.org,tenant.channel,tenant.conversation])).rows[0]!;
  // Canonical fixtures apply the journal once. The populated predecessor upgrade
  // was verified separately by the isolated candidate gate before promotion.

});
afterAll(async()=>{await db?.dispose();});
it('requires the composed 0054 structures, tenant policies and enabled immutable trigger rather than a service-only readiness',async()=>{
  expect(RUNTIME_SCHEMA_BASELINE).toBe('0068_flow_domain_commands');
  expect(await db.transact(tenant.org,tx=>probeRequiredRuntimeSchema(sql=>tx.query(sql)))).toBe(true);
  const client=await db.database.pool.connect();try{
    await client.query('BEGIN');await client.query('ALTER TABLE whatsapp_group_automation_sessions DISABLE TRIGGER whatsapp_group_session_immutable');
    await client.query('SET LOCAL ROLE jrc_app');
    expect(await probeRequiredRuntimeSchema(sql=>client.query(sql))).toBe(false);
  }finally{await client.query('ROLLBACK');client.release();}
});
it('admits a GROUP conversation with no invented contact and a distinct group destination',async()=>{
  const columns=(await db.database.pool.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name='messaging_conversations' AND column_name IN ('recipient_kind','group_jid','contact_id')")).rows;
  expect(columns).toEqual(expect.arrayContaining([{column_name:'recipient_kind',is_nullable:'NO'},{column_name:'group_jid',is_nullable:'YES'},{column_name:'contact_id',is_nullable:'YES'}]));
  const row=await db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_conversations(id,organization_id,channel_id,recipient_kind,group_jid,contact_id)
    VALUES($1,$2,$3,'GROUP','120363999000001@g.us',NULL) RETURNING recipient_kind,group_jid,contact_id`,[randomUUID(),tenant.org,tenant.channel]));
  expect(row.rows[0]).toEqual({recipient_kind:'GROUP',group_jid:'120363999000001@g.us',contact_id:null});
});
it('preserves the individual contact and all historical conversation fields',async()=>{
  const row=(await db.database.pool.query('SELECT * FROM messaging_conversations WHERE id=$1',[tenant.conversation])).rows[0]!;
  expect(row).toMatchObject(historical);
  expect(row.recipient_kind).toBe('INDIVIDUAL');expect(row.group_jid).toBeNull();
  expect((await db.database.pool.query('SELECT count(*)::int AS count FROM messaging_contacts WHERE organization_id=$1',[tenant.org])).rows[0]!.count).toBe(1);
});
it('retains individual messages/outbox/unresolved ledger after installing the canonical schema without approving or fabricating group history',async()=>{
  expect((await db.database.pool.query('SELECT * FROM messaging_messages WHERE id=$1',[oldMessage.id])).rows[0]).toMatchObject({...oldMessage,provider_scope:''});
  expect((await db.database.pool.query('SELECT * FROM messaging_outbox WHERE message_id=$1',[oldMessage.id])).rows[0]).toEqual(oldOutbox);
  expect((await db.database.pool.query('SELECT * FROM qr_outbound_observations WHERE id=$1',[oldObservation.id])).rows[0]).toMatchObject({...oldObservation,provider_scope:''});
  for(const table of ['whatsapp_group_automation_controls','whatsapp_group_automation_sessions','whatsapp_group_transport_facts'])
    expect((await db.database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n).toBe(0);
});
it('forces tenant RLS and excludes public/auth/platform DELETE or direct table grants',async()=>{
  const tables=['whatsapp_group_automation_controls','whatsapp_group_automation_sessions','whatsapp_group_transport_facts'];
  const rows=(await db.database.pool.query('SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[]) ORDER BY relname',[tables])).rows;
  expect(rows).toHaveLength(3);for(const row of rows){expect(row.relrowsecurity).toBe(true);expect(row.relforcerowsecurity).toBe(true);}
  for(const table of tables){
    for(const role of ['jrc_auth','jrc_platform'])
      expect((await db.database.pool.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',[role,table])).rows[0]!.allowed).toBe(false);
    expect((await db.database.pool.query('SELECT EXISTS(SELECT 1 FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault(\'r\',c.relowner))) a WHERE c.oid=$1::regclass AND a.grantee=0) AS allowed',[table])).rows[0]!.allowed).toBe(false);
    expect((await db.database.pool.query('SELECT has_table_privilege(\'jrc_app\',$1,\'DELETE\') AS allowed',[table])).rows[0]!.allowed).toBe(false);
  }
});
it('rejects hybrid destinations rather than treating a group as a phone contact',async()=>{
  const columns=(await db.database.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='messaging_conversations' AND column_name='recipient_kind'")).rows;
  expect(columns).toHaveLength(1);
  const contact=historical.contact_id;
  await expect(db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_conversations(organization_id,channel_id,recipient_kind,group_jid,contact_id)
    VALUES($1,$2,'GROUP','120363999000001@g.us',$3)`,[tenant.org,tenant.channel,contact]))).rejects.toMatchObject({code:'23514'});
  await expect(db.transact(tenant.org,tx=>tx.query(`INSERT INTO messaging_conversations(organization_id,channel_id,recipient_kind,group_jid,contact_id)
    VALUES($1,$2,'INDIVIDUAL','120363999000001@g.us',$3)`,[tenant.org,tenant.channel,contact]))).rejects.toMatchObject({code:'23514'});
});
