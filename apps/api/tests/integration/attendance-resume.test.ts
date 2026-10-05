import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createAttendanceResumeService } from '../../src/modules/attendance/resume-service.js';

describe('durable attendance resume admission', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
  afterAll(async () => { await db?.dispose(); });
  async function fixture() {
    const t = await seedAttendanceTenant(db.database, false);
    const actor = (await db.database.pool.query('select user_id from memberships where organization_id=$1', [t.org])).rows[0].user_id;
    await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [t.org]);
    await db.database.pool.query("update automation_definitions set lifecycle_status='PUBLISHED',active_version=1 where organization_id=$1", [t.org]);
    await db.database.pool.query("update messaging_channels set bot_public_id=$2,bot_origin_reference='jrc-automation-v2' where id=$1", [t.channel,t.automation]);
    await db.database.pool.query('insert into automation_bindings(organization_id,automation_id,version,channel_id) values($1,$2,1,$3)', [t.org,t.automation,t.channel]);
    await db.database.pool.query("insert into attendance_owners(organization_id,channel_id,revision,executor,automation_id,version) values($1,$2,1,'BROKER',$3,1)", [t.org,t.channel,t.automation]);
    await db.database.pool.query("update messaging_conversations set mode='HUMAN' where id=$1", [t.conversation]);
    return { ...t, actor, input: { conversationId:t.conversation,expectedControlRevision:0,expectedOwnerRevision:1,target:{kind:'NEW_SESSION' as const} } };
  }
  const service = () => createAttendanceResumeService({ transact:db.transact });
  it('reserves once while keeping a legacy conversation blocked; duplicate keys return the same operation', async () => {
    const t = await fixture(), s = service();
    const first = await s.requestAttendanceResume(t.org,t.actor,'same-key',t.input);
    expect(first).toMatchObject({state:'PENDING',sessionId:null});
    expect(await s.requestAttendanceResume(t.org,t.actor,'same-key',t.input)).toEqual(first);
    const local = (await db.database.pool.query('select mode from messaging_conversations where id=$1',[t.conversation])).rows[0];
    expect(local.mode).toBe('HUMAN');
    expect((await db.database.pool.query('select * from attendance_sessions where organization_id=$1',[t.org])).rowCount).toBe(0);
    await expect(s.requestAttendanceResume(t.org,t.actor,'same-key',{...t.input,target:{kind:'CONTINUE'}}))
      .rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED',statusCode:409});
  });
  it('rejects stale revisions before creating work', async () => {
    const t = await fixture();
    await expect(service().requestAttendanceResume(t.org,t.actor,'stale',{...t.input,expectedOwnerRevision:0}))
      .rejects.toMatchObject({code:'ATTENDANCE_OWNER_CHANGED'});
    await expect(service().requestAttendanceResume(t.org,t.actor,'stale-control',{...t.input,expectedControlRevision:7}))
      .rejects.toMatchObject({code:'ATTENDANCE_REMOTE_CONTROL_CHANGED'});
    expect((await db.database.pool.query('select * from attendance_resume_operations where organization_id=$1',[t.org])).rowCount).toBe(0);
  });
  it('isolates operations across tenants even when their UUID is known', async () => {
    const a = await fixture(), b = await fixture(), s = service();
    const op = await s.requestAttendanceResume(a.org,a.actor,randomUUID(),a.input);
    await expect(s.getOperation(b.org,op.id)).rejects.toMatchObject({statusCode:404});
    expect(await db.transact(b.org,tx=>tx.query('select * from attendance_resume_operations where id=$1',[op.id])))
      .toMatchObject({rowCount:0});
  });
  it('serializes two operators with different keys', async () => {
    const t = await fixture(), s = service();
    const outcomes = await Promise.allSettled([s.requestAttendanceResume(t.org,t.actor,'one',t.input),s.requestAttendanceResume(t.org,t.actor,'two',t.input)]);
    expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);
    expect(outcomes.find(o=>o.status==='rejected')).toMatchObject({reason:{code:'ATTENDANCE_RESUME_IN_PROGRESS'}});
  });
});
