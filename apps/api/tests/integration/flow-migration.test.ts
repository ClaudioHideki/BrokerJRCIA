import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {attendanceDatabaseBeforeFlow as attendanceDatabase} from './helpers/flow-promotion-test-fixture.js';
import {queryAsTenant} from './helpers/postgres.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {createFlowDelegationService} from '../../src/modules/flows/delegation/service.js';
import {approveOriginFixture} from './helpers/flow-origin-fixture.js';
import {flowDelegationRuntimeSql} from '../../src/db/flow-delegation-runtime-schema.js';

const tables=['flow_delegation_credentials','flow_delegation_sessions','flow_delegation_session_grants','flow_member_grants','flow_executor_profiles','automation_definition_scopes','flow_executor_cutovers'];
const graph={nodes:[{id:'s',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'e',type:'end',label:'End',position:{x:1,y:0},data:{}}],edges:[{id:'next',source:'s',target:'e',port:'next'}]};
const scopes=['flow:read','flow:edit','flow:publish','flow:bind'];
const vault=createIntegrationSecrets(Buffer.alloc(32,31).toString('base64'));
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
let platform:Pool,worker:Pool,auth:Pool;
let legacy:Awaited<ReturnType<typeof seedAttendanceTenant>>,legacyBefore:unknown,journalBefore:unknown;
const hash=(token:string)=>createHash('sha256').update(token).digest('hex');
function rolePool(role:'jrc_auth'|'jrc_platform'|'jrc_lifecycle'){
 const url=new URL(db.database.connectionString);url.username=role;url.password='';return new Pool({connectionString:url.href,max:1});
}
async function historical(){
 return {
  definitions:(await db.database.pool.query('SELECT organization_id,id,name,lifecycle_status,draft_graph,draft_revision,active_version,created_at,updated_at FROM automation_definitions WHERE organization_id=$1 ORDER BY id',[legacy.org])).rows,
  versions:(await db.database.pool.query('SELECT * FROM automation_versions WHERE organization_id=$1 ORDER BY automation_id,version',[legacy.org])).rows,
  channels:(await db.database.pool.query('SELECT * FROM messaging_channels WHERE organization_id=$1 ORDER BY id',[legacy.org])).rows,
  messages:(await db.database.pool.query('SELECT * FROM messaging_messages WHERE organization_id=$1 ORDER BY id',[legacy.org])).rows,
 };
}
beforeAll(async()=>{
 db=await attendanceDatabase();legacy=await seedAttendanceTenant(db.database);
 await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,upstream_message_id)
  VALUES($1,$2,$3,$4,'INCOMING','CONTACT','{"type":"TEXT","text":"Synthetic legacy history"}','DELIVERED','synthetic-p9-history')`,[randomUUID(),legacy.org,legacy.channel,legacy.conversation]);
 legacyBefore=await historical();journalBefore=(await db.database.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
 const client=await db.database.pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE jrc_migrator');await client.query(await readFile(new URL('../../drizzle/migrations/0053_flow_delegation.sql',import.meta.url),'utf8'));await client.query('COMMIT');}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 platform=rolePool('jrc_platform');worker=rolePool('jrc_lifecycle');auth=rolePool('jrc_auth');
});
afterAll(async()=>{await platform?.end();await worker?.end();await auth?.end();await db?.dispose();});

async function fixture(){
 const t=await seedAttendanceTenant(db.database),instance=randomUUID();
 const provider=(await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
 await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1",[provider]);
 await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Synthetic P9 QR',$4,'CONNECTED')",[instance,t.org,provider,`synthetic-p9-${instance}`]);
 await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$3,phone_number_id=NULL,waba_id=NULL WHERE organization_id=$1 AND id=$2",[t.org,t.channel,instance]);
 const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[t.org])).rows[0]!.user_id;
 const authVersion=(await db.database.pool.query('SELECT auth_version FROM users WHERE id=$1',[actor])).rows[0]!.auth_version;
 await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic-token')]);
 await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[t.org]);
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true) ON CONFLICT(organization_id) DO UPDATE SET enabled=true',[t.org]);
 const principal={organizationId:t.org,actorId:actor,authVersion},service=createFlowDelegationService({transact:db.transact,automation:{enabled:true}});
 const session=await service.issueBrokerSession(principal,{integrationIds:[t.integration],scopes});
 const credential=await service.issueNativeCredential(principal,{scopes,expiresInSeconds:600});
 await approveOriginFixture(db.database,t.org,'STOCK');
 await service.configureExecutorProfile(principal,{integrationId:t.integration,expectedRevision:0});
 await service.setMemberGrant(principal,{userId:actor,integrationId:t.integration,scopes:['flow:read'],expectedRevision:0});
 const access={organizationId:t.org,token:session.token},draft=await service.create(access,{name:'Scoped lifecycle fixture',graph,integrationIds:[t.integration]});
 await db.database.pool.query(`INSERT INTO flow_executor_cutovers(organization_id,integration_id,channel_id,host_kind,profile_revision,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,expected_owner_revision,phase)
  SELECT organization_id,integration_id,$2,host_kind,revision,origin_capability_revision,account_id,inbox_id,destination_revision,account_credential_version,0,'ROLLED_BACK' FROM flow_executor_profiles WHERE organization_id=$1 AND integration_id=$3`,[t.org,t.channel,t.integration]);
 return {...t,instance,actor,principal,service,session,credential,access,draft};
}
async function readyPurge(deletion:string){
 const lease=randomUUID();await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1",[deletion]);
 await db.database.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[deletion,lease]);return lease;
}
async function platformActor(){
 const actor=randomUUID();await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')",[actor,`${actor}@example.test`]);return actor;
}

it('preserves legacy canonical graphs, immutable versions and history without backfilling delegated scope',async()=>{
 expect(await historical()).toEqual(legacyBefore);
 expect((await db.database.pool.query('SELECT id,hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows).toEqual(journalBefore);
 expect((await db.database.pool.query('SELECT delegation_scope_revision FROM automation_definitions WHERE organization_id=$1',[legacy.org])).rows).toEqual([{delegation_scope_revision:0}]);
 expect((await db.database.pool.query('SELECT * FROM automation_definition_scopes WHERE organization_id=$1',[legacy.org])).rows).toEqual([]);
 const canonical=createAutomationService({transact:db.transact});
 expect(await canonical.get(legacy.org,legacy.automation)).toMatchObject({id:legacy.automation});
 expect((await canonical.versions(legacy.org,legacy.automation)).data).toHaveLength(1);
});
it('requires Flow forced RLS, isolated role privileges and auth lookup execution in the runtime schema probe',async()=>{
 const ready=async()=> (await db.database.pool.query('SELECT ('+flowDelegationRuntimeSql+') AS ready')).rows[0].ready;
 expect(await ready()).toBe(true);
 await db.database.pool.query('REVOKE UPDATE ON flow_executor_profiles FROM jrc_app');
 try{expect(await ready()).toBe(false);}finally{await db.database.pool.query('GRANT UPDATE ON flow_executor_profiles TO jrc_app');}
 await db.database.pool.query('REVOKE EXECUTE ON FUNCTION resolve_flow_delegation_session(text) FROM jrc_auth');
 try{expect(await ready()).toBe(false);}finally{await db.database.pool.query('GRANT EXECUTE ON FUNCTION resolve_flow_delegation_session(text) TO jrc_auth');}
 await db.database.pool.query('ALTER TABLE flow_member_grants NO FORCE ROW LEVEL SECURITY');
 try{expect(await ready()).toBe(false);}finally{await db.database.pool.query('ALTER TABLE flow_member_grants FORCE ROW LEVEL SECURITY');}
 await db.database.pool.query('GRANT SELECT ON flow_executor_cutovers TO jrc_auth');
 try{expect(await ready()).toBe(false);}finally{await db.database.pool.query('REVOKE SELECT ON flow_executor_cutovers FROM jrc_auth');}
});

it('enforces forced tenant RLS and composite tenant FKs independently of the service',async()=>{
 const a=await fixture(),b=await fixture();
 expect((await queryAsTenant(db.database.pool,'jrc_app',a.org,'SELECT id FROM flow_delegation_sessions WHERE organization_id=$1',[b.org])).rows).toEqual([]);
 expect((await queryAsTenant(db.database.pool,'jrc_app',a.org,"UPDATE flow_member_grants SET scopes='{}' WHERE organization_id=$1",[b.org])).rowCount).toBe(0);
 await expect(queryAsTenant(db.database.pool,'jrc_app',a.org,"INSERT INTO flow_member_grants(organization_id,user_id,integration_id,scopes,created_by) VALUES($1,$2,$3,ARRAY['flow:read'],$2)",[a.org,a.actor,b.integration])).rejects.toMatchObject({code:'23503'});
 await expect(queryAsTenant(db.database.pool,'jrc_app',a.org,"INSERT INTO flow_member_grants(organization_id,user_id,integration_id,scopes,created_by) VALUES($1,$2,$3,ARRAY['flow:read'],$2)",[b.org,b.actor,randomUUID()])).rejects.toMatchObject({code:'42501'});
 const rules=(await db.database.pool.query('SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname=ANY($1::text[]) ORDER BY c.relname',[tables])).rows;
 expect(rules).toEqual([...tables].sort().map(relname=>({relname,relrowsecurity:true,relforcerowsecurity:true,owner:'jrc_migrator'})));
});

it('permits only the authentication role to resolve a current opaque token tenant and denies table disclosure',async()=>{
 const t=await fixture();
 expect((await auth.query('SELECT resolve_flow_delegation_session($1) AS org',[hash(t.session.token)])).rows).toEqual([{org:t.org}]);
 expect((await auth.query('SELECT resolve_flow_delegation_credential($1) AS org',[hash(t.credential.token)])).rows).toEqual([{org:t.org}]);
 await expect(auth.query('SELECT token_hash FROM flow_delegation_sessions')).rejects.toMatchObject({code:'42501'});
 await expect(queryAsTenant(db.database.pool,'jrc_app',t.org,'SELECT resolve_flow_delegation_session($1)',[hash(t.session.token)])).rejects.toMatchObject({code:'42501'});
 await t.service.revokeSession(t.principal,t.session.id);
 expect((await auth.query('SELECT resolve_flow_delegation_session($1) AS org',[hash(t.session.token)])).rows).toEqual([{org:null}]);
 await t.service.revokeNativeCredential(t.principal,t.credential.id);
 expect((await auth.query('SELECT resolve_flow_delegation_credential($1) AS org',[hash(t.credential.token)])).rows).toEqual([{org:null}]);
 for(const table of tables)for(const role of ['jrc_auth','jrc_platform'])expect((await db.database.pool.query("SELECT has_table_privilege($1,$2,'SELECT') OR has_table_privilege($1,$2,'INSERT') OR has_table_privilege($1,$2,'UPDATE') OR has_table_privilege($1,$2,'DELETE') AS allowed",[role,table])).rows).toEqual([{allowed:false}]);
});

it('purges all new channel dependencies, revokes sessions and tombstones empty scope while preserving other tenants',async()=>{
 const t=await fixture(),survivor=await fixture();
 const survivorBefore=(await db.database.pool.query('SELECT * FROM automation_definition_scopes WHERE organization_id=$1',[survivor.org])).rows;
 const deletion=(await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id',[t.org,t.instance,'Synthetic P9 QR','Synthetic authorized deletion','TENANT',t.actor])).rows[0]!.id;
 await worker.query('SELECT lifecycle_purge_channel($1,$2)',[deletion,await readyPurge(deletion)]);
 expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rows).toEqual([]);
 for(const table of ['flow_delegation_session_grants','flow_member_grants','flow_executor_profiles','automation_definition_scopes','flow_executor_cutovers'])expect((await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`,[t.org])).rows).toEqual([]);
 expect((await db.database.pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM flow_delegation_sessions WHERE id=$1',[t.session.id])).rows).toEqual([{revoked:true}]);
 expect((await db.database.pool.query('SELECT delegation_scope_revision FROM automation_definitions WHERE id=$1',[t.draft.id])).rows).toEqual([{delegation_scope_revision:2}]);
 expect((await db.database.pool.query('SELECT * FROM automation_definition_scopes WHERE organization_id=$1',[survivor.org])).rows).toEqual(survivorBefore);
 expect((await db.database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1',[deletion])).rows).toEqual([{status:'COMPLETED'}]);
});

it('purges every new organization table through the real lifecycle catalogue without deleting another tenant',async()=>{
 const t=await fixture(),survivor=await fixture(),actor=await platformActor();
 const deletion=(await platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4) AS id',[t.org,'Attendance','Synthetic authorized organization deletion',actor])).rows[0]!.id;
 await worker.query('SELECT lifecycle_purge_organization($1,$2)',[deletion,await readyPurge(deletion)]);
 for(const table of tables)expect((await db.database.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`,[t.org])).rows).toEqual([]);
 expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1',[t.org])).rows).toEqual([]);
 expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1',[survivor.org])).rows).toEqual([{id:survivor.org}]);
 expect((await db.database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1',[deletion])).rows).toEqual([{status:'COMPLETED'}]);
});

it.each(['CHANNEL','ORGANIZATION'] as const)('blocks actual %s admission and executable purge while an external cutover remains UNKNOWN',async kind=>{
 const t=await fixture(),actor=kind==='CHANNEL'?t.actor:await platformActor();
 await db.database.pool.query("UPDATE flow_executor_cutovers SET phase='UNKNOWN' WHERE organization_id=$1",[t.org]);
 const request=()=>kind==='CHANNEL'?platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6)',[t.org,t.instance,'Synthetic P9 QR','Synthetic pending cutover','TENANT',actor]):platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4)',[t.org,'Attendance','Synthetic pending cutover',actor]);
 await expect(request()).rejects.toMatchObject({constraint:'lifecycle_pending_work'});
 const deletion=randomUUID(),lease=randomUUID();
 // Recovered job fixture exercises the executable purge guard independently
 // of the preceding platform admission guard; this never calls a provider.
 await db.database.pool.query(`INSERT INTO lifecycle_deletions(id,organization_id,kind,resource_id,messaging_channel_id,provider,resource_name,actor_kind,actor_id,status,lease_token,lease_expires_at)
  VALUES($1,$2,$3,$4,$5,$6,'Synthetic recovered job',$7,$8,'REMOVING_DATA',$9,clock_timestamp()+interval '1 minute')`,[deletion,t.org,kind,kind==='CHANNEL'?t.instance:t.org,kind==='CHANNEL'?t.channel:null,kind==='CHANNEL'?'QR':null,kind==='CHANNEL'?'TENANT':'PLATFORM',actor,lease]);
 await expect(worker.query(kind==='CHANNEL'?'SELECT lifecycle_purge_channel($1,$2)':'SELECT lifecycle_purge_organization($1,$2)',[deletion,lease])).rejects.toMatchObject({constraint:'lifecycle_pending_work'});
 expect((await db.database.pool.query('SELECT phase FROM flow_executor_cutovers WHERE organization_id=$1',[t.org])).rows).toEqual([{phase:'UNKNOWN'}]);
 expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rows).toEqual([{id:t.channel}]);
});
