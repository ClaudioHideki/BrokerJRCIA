import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { attendanceDatabase } from './helpers/attendance.js';
import { resumeFixture } from './helpers/attendance-resume.js';
import { connectionStringForRole } from './helpers/task7.js';
import { createLifecycleService,withLifecyclePlatformTransaction } from '../../src/modules/lifecycle/service.js';

describe('resume uncertainty fences executable deletion, not only its preview',()=>{
  let db:Awaited<ReturnType<typeof attendanceDatabase>>,platform:Pool,worker:Pool;
  const admin=randomUUID();
  beforeAll(async()=>{
    db=await attendanceDatabase();
    platform=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_platform')});
    worker=new Pool({connectionString:connectionStringForRole(db.database.connectionString,'jrc_lifecycle')});
    await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'no-login','SUPER_ADMIN','no-login')",[admin,`${admin}@example.test`]);
  },60000);
  afterAll(async()=>{await platform?.end();await worker?.end();await db?.dispose();});
  it.each(['PENDING','UNKNOWN','ACTION_REQUIRED'] as const)('keeps the channel/company and journal when remote state is %s',async state=>{
    const t=await resumeFixture(db),op=await t.reserve(),resource=randomUUID();
    await db.database.pool.query("UPDATE attendance_resume_operations SET state=$3,phase='CLEAR_AGENT' WHERE organization_id=$1 AND id=$2",[t.org,op.id,state]);
    await db.database.pool.query("INSERT INTO meta_connections(id,organization_id,channel_id,waba_id,phone_number_id,encrypted_token,graph_version,status) VALUES($1,$2,$3,'synthetic',$4,'synthetic','v-test','READY')",[resource,t.org,t.channel,resource]);
    const service=createLifecycleService({transact:work=>withLifecyclePlatformTransaction(platform,work),deprovision:async()=>{throw new Error('must not deprovision');}});
    // A caller can submit directly even after a stale preview; the executable guard must reject it.
    await expect(service.requestChannel(t.org,resource,'WhatsApp oficial','Synthetic authorized cleanup','TENANT',t.actor)).rejects.toMatchObject({code:'LIFECYCLE_PENDING_WORK'});
    await expect(service.requestOrganization(t.org,'Attendance','Synthetic authorized cleanup',admin)).rejects.toMatchObject({code:'LIFECYCLE_PENDING_WORK'});
    expect(await service.previewChannel(t.org,resource)).toMatchObject({canDelete:false});
    expect(await service.previewOrganization(t.org)).toMatchObject({canDelete:false});
    for(const kind of ['CHANNEL','ORGANIZATION'] as const){
      const deletion=randomUUID(),lease=randomUUID();
      // Represents an older authorized cleanup recovered by a replacement worker.
      await db.database.pool.query(`INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,messaging_channel_id,provider,actor_kind,actor_id,status,lease_token,lease_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,'PLATFORM',$7,'REMOVING_DATA',$8,now()+interval '1 minute')`,
        [deletion,t.org,kind,kind==='CHANNEL'?resource:t.org,kind==='CHANNEL'?t.channel:null,kind==='CHANNEL'?'META':null,admin,lease]);
      const functionName=kind==='CHANNEL'?'lifecycle_purge_channel':'lifecycle_purge_organization';
      await expect(worker.query(`SELECT public.${functionName}($1,$2)`,[deletion,lease])).rejects.toMatchObject({constraint:'lifecycle_pending_work'});
    }
    expect((await db.database.pool.query('SELECT id,state FROM attendance_resume_operations WHERE organization_id=$1',[t.org])).rows).toEqual([{id:op.id,state}]);
    expect((await db.database.pool.query('SELECT deleting_at FROM messaging_channels WHERE id=$1',[t.channel])).rows[0].deleting_at).toBeNull();
    expect((await db.database.pool.query('SELECT status FROM organizations WHERE id=$1',[t.org])).rows[0].status).toBe('ACTIVE');
  });
});
