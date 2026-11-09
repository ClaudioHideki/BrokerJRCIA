import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {postgresBoxProfileStore} from '../../src/modules/automations/box-routing-service.js';
import {BoxDirectorySnapshotSchema,BoxRoutingConfigSchema} from '@jrc/contracts';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{
 db=await attendanceDatabase();
 const ready=(await db.database.pool.query("SELECT to_regclass('public.automation_box_profile_heads') IS NOT NULL AS ready")).rows[0]?.ready;
 expect(ready).toBe(true);
},60000);
afterAll(async()=>{await db?.dispose();});
const store=postgresBoxProfileStore();
async function tenant(){
 const t=await seedAttendanceTenant(db.database);
 const config=BoxRoutingConfigSchema.parse({schemaVersion:1,routes:[{routeKey:'sales',teamId:4,mode:'AGENT',membership:'SELECTED',agentIds:[8]}]});
 const snapshot=BoxDirectorySnapshotSchema.parse({schemaVersion:1,profileRevision:1,scope:t.scope,credentialRevision:1,
  routes:[{routeKey:'sales',teamId:4,teamName:'Comercial',mode:'AGENT',agents:[{id:8,name:'Pessoa autorizada'}]}]});
 return {...t,write:{organizationId:t.org,automationId:t.automation,version:1,channelId:t.channel,expectedRevision:0,actorId:randomUUID(),config,snapshot}};
}
it('isolates profile data by tenant and rejects cross-tenant inserts at RLS',async()=>{
 const a=await tenant(),b=await tenant();await db.transact(a.org,tx=>store.write(tx,a.write));
 expect(await db.transact(b.org,tx=>store.read(tx,b.org,a.automation,1,a.channel))).toBeNull();
 expect((await db.transact(b.org,tx=>tx.query('SELECT revision FROM automation_box_profile_versions WHERE organization_id=$1',[a.org]))).rowCount).toBe(0);
 await expect(db.transact(b.org,tx=>tx.query(`INSERT INTO automation_box_profile_versions(organization_id,channel_id,automation_id,version,revision,config,snapshot,actor_id)
  VALUES($1,$2,$3,1,2,$4,$5,$6)`,[a.org,a.channel,a.automation,JSON.stringify(a.write.config),JSON.stringify(a.write.snapshot),a.write.actorId]))).rejects.toMatchObject({code:'42501'});
});
it('serializes concurrent revision-zero writes without partial heads or duplicate history',async()=>{
 const t=await tenant(),outcomes=await Promise.allSettled([db.transact(t.org,tx=>store.write(tx,t.write)),db.transact(t.org,tx=>store.write(tx,t.write))]);
 expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect((await db.transact(t.org,tx=>store.read(tx,t.org,t.automation,1,t.channel)))?.revision).toBe(1);
 expect(Number((await db.database.pool.query('SELECT count(*) FROM automation_box_profile_versions WHERE organization_id=$1',[t.org])).rows[0]?.count)).toBe(1);
});
it('keeps previous revisions immutable and does not reopen human conversations or create effects',async()=>{
 const t=await tenant();await db.database.pool.query("UPDATE messaging_conversations SET mode='HUMAN' WHERE organization_id=$1 AND id=$2",[t.org,t.conversation]);
 await db.transact(t.org,tx=>store.write(tx,t.write));
 await db.transact(t.org,tx=>store.write(tx,{...t.write,expectedRevision:1}));
 expect((await db.transact(t.org,tx=>store.read(tx,t.org,t.automation,1,t.channel)))?.revision).toBe(2);
 await expect(db.database.pool.query('UPDATE automation_box_profile_versions SET config=config WHERE organization_id=$1 AND revision=1',[t.org])).rejects.toThrow('FLOW_BOX_PROFILE_IMMUTABLE');
 expect((await db.database.pool.query('SELECT mode FROM messaging_conversations WHERE organization_id=$1 AND id=$2',[t.org,t.conversation])).rows[0]?.mode).toBe('HUMAN');
 expect(Number((await db.database.pool.query('SELECT count(*) FROM automation_outbox WHERE organization_id=$1',[t.org])).rows[0]?.count)).toBe(0);
});
it('rolls back the active profile pointer when the binding transaction cannot commit',async()=>{
 const t=await tenant();await db.transact(t.org,tx=>store.write(tx,t.write));
 expect(await db.transact(t.org,tx=>store.read(tx,t.org,t.automation,1,t.channel,'ACTIVE'))).toBeNull();
 await expect(db.transact(t.org,async tx=>{await store.activate(tx,t.org,t.automation,1,t.channel,1);throw Error('SIMULATED_OWNER_CAS_FAILURE');})).rejects.toThrow('SIMULATED_OWNER_CAS_FAILURE');
 expect(await db.transact(t.org,tx=>store.read(tx,t.org,t.automation,1,t.channel,'ACTIVE'))).toBeNull();
 await db.transact(t.org,tx=>store.activate(tx,t.org,t.automation,1,t.channel,1));
 await db.transact(t.org,tx=>store.write(tx,{...t.write,expectedRevision:1}));
 expect((await db.transact(t.org,tx=>store.read(tx,t.org,t.automation,1,t.channel,'ACTIVE')))?.revision).toBe(1);
});
