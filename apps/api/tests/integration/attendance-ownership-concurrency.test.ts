import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';

describe('attendance ownership CAS', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => { db = await attendanceDatabase(); }, 60000);
  afterAll(async () => { await db?.dispose(); });
  it('allows exactly one of two competing initial claims and rejects stale revisions', async () => {
    const a = await seedAttendanceTenant(db.database);
    const { createOwnershipService } = await import('../../src/modules/attendance/ownership-service.js');
    const service = createOwnershipService({ transact: db.transact });
    const outcomes = await Promise.allSettled([
      service.claimInboxOwner(a.scope, { executor:'BROKER',automationId:a.automation,version:1,expectedRevision:0 }),
      service.claimInboxOwner(a.scope, { executor:'EXTERNAL',automationId:null,version:null,expectedRevision:0 }),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({reason:{code:'ATTENDANCE_OWNER_CHANGED',statusCode:409}});
    const owners = await db.transact(a.org, tx => tx.query('select revision,executor from attendance_owners where channel_id=$1',[a.channel]));
    expect(owners.rows).toHaveLength(1);
    expect(owners.rows[0].revision).toBe(1);
    await expect(service.claimInboxOwner(a.scope,{executor:'NONE',automationId:null,version:null,expectedRevision:0}))
      .rejects.toMatchObject({code:'ATTENDANCE_OWNER_CHANGED'});
  });
  it('resolves scope from trusted rows, rejects stale remote identifiers and preserves local channels', async () => {
    const a = await seedAttendanceTenant(db.database), b = await seedAttendanceTenant(db.database,false);
    const { createOwnershipService } = await import('../../src/modules/attendance/ownership-service.js');
    const service = createOwnershipService({ transact:db.transact });
    expect(await service.resolveScope(a.org,a.channel)).toEqual(a.scope);
    expect(await service.resolveScope(b.org,b.channel)).toBeNull();
    await expect(service.claimInboxOwner({...a.scope,inboxId:99},{executor:'NONE',automationId:null,version:null,expectedRevision:0}))
      .rejects.toMatchObject({code:'ATTENDANCE_SCOPE_CHANGED'});
    await expect(service.claimInboxOwner({...a.scope,organizationId:b.org},{executor:'NONE',automationId:null,version:null,expectedRevision:0}))
      .rejects.toMatchObject({code:'CHANNEL_NOT_FOUND'});
    const owner = await service.claimChannelOwner(b.org,b.channel,{executor:'BROKER',automationId:b.automation,version:1,expectedRevision:0});
    expect(owner).toEqual({channelId:b.channel,integrationId:null,executor:'BROKER',automationId:b.automation,version:1,revision:1});
    expect((await db.transact(a.org, tx=>tx.query('select * from attendance_owners where channel_id=$1',[b.channel]))).rows).toEqual([]);
    await expect(service.claimChannelOwner(b.org,b.channel,{executor:'BROKER',automationId:a.automation,version:1,expectedRevision:1}))
      .rejects.toMatchObject({code:'AUTOMATION_VERSION_NOT_FOUND'});
    expect((await db.transact(b.org, tx=>tx.query('select revision from attendance_owners where channel_id=$1',[b.channel]))).rows).toEqual([{revision:1}]);
  });
});
