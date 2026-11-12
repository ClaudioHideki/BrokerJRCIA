import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { attendanceDatabase,seedAttendanceTenant } from './helpers/attendance.js';
import { createHistorySyncProgressService } from '../../src/modules/history-sync/progress-service.js';

it('looks up canonical channel progress only under current membership and tenant; reads cannot start captures',async()=>{
  const db=await attendanceDatabase();
  try {
    const t=await seedAttendanceTenant(db.database);
    const actor=randomUUID();
    await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic')",[actor,`${actor}@example.test`]);
    await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OPERATOR')",[t.org,actor]);
    const service=createHistorySyncProgressService({transact:db.transact});
    expect(await service.latest(t.org,actor,t.channel)).toEqual({schemaVersion:2,organizationId:t.org,channelId:t.channel,run:null});
    const other=await seedAttendanceTenant(db.database);
    await expect(service.latest(other.org,actor,t.channel)).rejects.toMatchObject({statusCode:403});
    await expect(service.latest(t.org,actor,randomUUID())).rejects.toMatchObject({statusCode:404});
    await db.database.pool.query('DELETE FROM memberships WHERE organization_id=$1 AND user_id=$2',[t.org,actor]);
    await expect(service.latest(t.org,actor,t.channel)).rejects.toMatchObject({statusCode:403});
    expect((await db.database.pool.query('SELECT count(*) FROM history_sync_runs')).rows[0].count).toBe('0');
  } finally {await db.dispose();}
},60000);
