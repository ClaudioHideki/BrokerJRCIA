import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';

describe('attendance tenant storage', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  let a: Awaited<ReturnType<typeof seedAttendanceTenant>>, b: typeof a;
  beforeAll(async () => { db = await attendanceDatabase(); a = await seedAttendanceTenant(db.database); b = await seedAttendanceTenant(db.database); }, 60000);
  afterAll(async () => { await db?.dispose(); });
  const insert = (org: string, channel: string, conversation: string, integration: string, cycle = 1) => db.transact(org, tx => tx.query(`
    insert into attendance_sessions(organization_id,channel_id,conversation_id,integration_id,destination_revision,account_id,inbox_id,cycle,state,owner_revision)
    values($1,$2,$3,$4,1,7,9,$5,'BOT_ACTIVE',1) returning id`, [org,channel,conversation,integration,cycle]));
  it('isolates sessions and ownership across tenants and rejects cross-tenant foreign keys', async () => {
    const session = await insert(a.org,a.channel,a.conversation,a.integration);
    expect((await db.transact(b.org, tx => tx.query('select * from attendance_sessions where id=$1',[session.rows[0].id]))).rows).toEqual([]);
    await expect(insert(b.org,a.channel,a.conversation,b.integration)).rejects.toMatchObject({ code: '23503' });
    await db.transact(a.org, tx => tx.query("update attendance_sessions set state='RESOLVED' where id=$1",[session.rows[0].id]));
    await expect(insert(a.org,a.channel,a.conversation,b.integration,2)).rejects.toMatchObject({ code: '23503' });
  });
  it('rejects a conversation from a different channel even in the same tenant', async () => {
    const channel = (await db.database.pool.query(`insert into messaging_channels(organization_id,provider_account_id,phone_number_id,waba_id,credential_reference)
      select organization_id,provider_account_id,'other-test','test',credential_reference from messaging_channels where id=$1 returning id`,[a.channel])).rows[0].id;
    await expect(insert(a.org,channel,a.conversation,a.integration,2)).rejects.toMatchObject({ code: '23503',constraint:'attendance_session_conversation_fk' });
  });
  it('allows sequential resolved cycles but never two live sessions for a conversation', async () => {
    await insert(b.org,b.channel,b.conversation,b.integration);
    await expect(insert(b.org,b.channel,b.conversation,b.integration,2)).rejects.toMatchObject({ code: '23505' });
    await db.transact(b.org, tx => tx.query("update attendance_sessions set state='RESOLVED' where organization_id=$1",[b.org]));
    await insert(b.org,b.channel,b.conversation,b.integration,2);
    expect((await db.transact(b.org, tx => tx.query('select cycle from attendance_sessions order by cycle'))).rows).toEqual([{ cycle: 1 },{ cycle: 2 }]);
  });
  it('does not confuse the same numeric account on distinct installations', async () => {
    expect((await db.database.pool.query('select account_id from chatwoot_accounts where organization_id=any($1)',[[a.org,b.org]])).rows).toEqual([{account_id:'7'},{account_id:'7'}]);
    await expect(db.database.pool.query(`update chatwoot_accounts set base_url=$2 where organization_id=$1`,[b.org,`https://${a.org}.example.test`])).rejects.toMatchObject({ code:'23505' });
  });

  async function executionFixture() {
    const tenant = await seedAttendanceTenant(db.database, false);
    const otherAutomation = randomUUID();
    await db.database.pool.query(`insert into automation_definitions(organization_id,id,name,draft_graph)
      values($1,$2,'Other','{}')`,[tenant.org,otherAutomation]);
    await db.database.pool.query(`insert into automation_versions(organization_id,automation_id,version,graph,checksum)
      values($1,$2,1,'{}',$4),($1,$3,2,'{}',$4)`,[tenant.org,otherAutomation,tenant.automation,'b'.repeat(64)]);
    const binding = (await db.database.pool.query(`insert into automation_bindings(organization_id,automation_id,version,channel_id)
      values($1,$2,1,$3) returning id`,[tenant.org,tenant.automation,tenant.channel])).rows[0].id;
    const execution = (await db.database.pool.query(`insert into automation_executions(organization_id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id)
      values($1,$2,1,$3,$4,$5,'test',$6) returning id`,[tenant.org,tenant.automation,binding,tenant.channel,tenant.conversation,randomUUID()])).rows[0].id as string;
    const create = (executionId:string|null, automationId:string|null, version:number|null) => db.transact(tenant.org, tx=>tx.query(`
      insert into attendance_sessions(organization_id,channel_id,conversation_id,cycle,state,owner_revision,execution_id,automation_id,version)
      values($1,$2,$3,1,'BOT_ACTIVE',0,$4,$5,$6) returning execution_id,automation_id,version`,
      [tenant.org,tenant.channel,tenant.conversation,executionId,automationId,version]));
    return {...tenant,otherAutomation,execution,create};
  }

  it.each(['different automation','different version','null metadata'] as const)('rejects an execution session with %s', async mismatch => {
    const fixture = await executionFixture();
    const automation = mismatch==='different automation' ? fixture.otherAutomation : mismatch==='null metadata' ? null : fixture.automation;
    const version = mismatch==='different version' ? 2 : mismatch==='null metadata' ? null : 1;
    await expect(fixture.create(fixture.execution,automation,version)).rejects.toMatchObject({
      code:mismatch==='null metadata'?'23514':'23503',
    });
  });

  it.each(['matching execution','pinned without execution','unassigned without execution'] as const)('preserves a valid session: %s', async kind => {
    const fixture = await executionFixture();
    const execution = kind==='matching execution'?fixture.execution:null;
    const automation = kind==='unassigned without execution'?null:fixture.automation;
    const version = kind==='unassigned without execution'?null:1;
    expect((await fixture.create(execution,automation,version)).rows).toEqual([{execution_id:execution,automation_id:automation,version}]);
  });
});
