import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {attendanceDatabaseBeforeFlow as attendanceDatabase} from './helpers/flow-promotion-test-fixture.js';
import {queryAsTenant} from './helpers/postgres.js';
import {PlatformService} from '../../src/modules/platform/service.js';
import {createFlowOriginApproval} from '../../src/modules/flows/delegation/origin-approval.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>,pool:Pool;
beforeAll(async()=>{db=await attendanceDatabase();await db.database.pool.query(await readFile(new URL('../../drizzle/migrations/0053_flow_delegation.sql',import.meta.url),'utf8'));const url=new URL(db.database.connectionString);url.username='jrc_platform';url.password='';pool=new Pool({connectionString:url.href,max:1});});
afterAll(async()=>{await pool?.end();await db?.dispose();});
async function fixture(){
 const t=await seedAttendanceTenant(db.database),actor=randomUUID(),token=randomUUID(),csrf=randomUUID();
 await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic','SUPER_ADMIN','synthetic')",[actor,`${actor}@example.test`]);
 await db.database.pool.query('INSERT INTO platform_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval \'10 minutes\')',[createHash('sha256').update(token).digest('hex'),actor,csrf]);
 await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='PENDING' WHERE organization_id=$1",[t.org]);
 const origin=(await db.database.pool.query('SELECT base_url FROM chatwoot_destinations WHERE organization_id=$1',[t.org])).rows[0]!.base_url;
 const hook=createFlowOriginApproval();
 const service=new (PlatformService as any)(pool,Buffer.alloc(32,35),{mfaRequired:false},hook) as PlatformService;
 return {...t,actor,token,csrf,origin,service};
}
it('creates a shared stock declaration in the same canonical destination approval and reuses it for another tenant',async()=>{
 const t=await fixture();
 const approve=(input:any)=>t.service.approveChatwootDestination(t.token,t.csrf,'Reviewed synthetic stock deployment',t.org,input);
 const first=await approve({revision:1,mediaOrigins:[],flowExecutor:{kind:'STOCK',expectedOriginRevision:0}});
 expect(first).toMatchObject({approvalStatus:'APPROVED',flowExecutor:{kind:'STOCK',revision:1}});
 expect((await db.database.pool.query('SELECT kind,revision,provenance FROM flow_executor_origins WHERE base_url=$1',[t.origin])).rows).toEqual([{kind:'STOCK',revision:1,provenance:'PLATFORM_DESTINATION_APPROVAL'}]);
 const other=await seedAttendanceTenant(db.database,false);
 await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode) VALUES($1,$2,'EXTERNAL')",[other.org,t.origin]);
 const reused=await t.service.approveChatwootDestination(t.token,t.csrf,'Reuse reviewed deployment in second tenant',other.org,{revision:1,mediaOrigins:[]});
 expect(reused).toMatchObject({approvalStatus:'APPROVED',flowExecutor:{kind:'STOCK',revision:1}});
 expect((await db.database.pool.query('SELECT count(*)::int AS n FROM platform_audit_logs WHERE organization_id IS NULL AND action=\'flow-origin-approve\' AND actor_id=$1',[t.actor])).rows).toEqual([{n:1}]);
});
it('projects a shared origin through current platform authority for a still pending second tenant without another declaration',async()=>{
 const t=await fixture();await t.service.approveChatwootDestination(t.token,t.csrf,'Initial reviewed stock origin declaration',t.org,{revision:1,mediaOrigins:[],flowExecutor:{kind:'STOCK',expectedOriginRevision:0}});
 const other=await seedAttendanceTenant(db.database,false);await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode) VALUES($1,$2,'EXTERNAL')",[other.org,t.origin]);
 const status={configured:true,baseUrl:t.origin,destination:{organizationId:other.org,baseUrl:t.origin,mode:'EXTERNAL',approvalStatus:'PENDING',mediaOrigins:[],revision:1},account:null,connections:[],jobs:{},provisioningAvailable:false};
 expect(await t.service.flowDestinationStatus(t.token,other.org,status as never)).toMatchObject({destination:{flowExecutor:{kind:'STOCK',revision:1,status:'READY'}}});
 await db.database.pool.query('UPDATE platform_users SET active=false WHERE id=$1',[t.actor]);
 await expect(t.service.flowDestinationStatus(t.token,other.org,status as never)).rejects.toMatchObject({code:'PLATFORM_INVALID_SESSION'});
});
it('rolls back destination approval atomically when the origin declaration is missing or stale',async()=>{
 const t=await fixture();
 await expect(t.service.approveChatwootDestination(t.token,t.csrf,'Synthetic missing origin declaration',t.org,{revision:1,mediaOrigins:[]})).rejects.toMatchObject({code:'FLOW_ORIGIN_DECLARATION_REQUIRED'});
 expect((await db.database.pool.query('SELECT approval_status FROM chatwoot_destinations WHERE organization_id=$1',[t.org])).rows).toEqual([{approval_status:'PENDING'}]);
 expect((await db.database.pool.query('SELECT id FROM platform_audit_logs WHERE organization_id=$1',[t.org])).rows).toEqual([]);
});
it('lets positive native deployment evidence prevail over stock declaration for every tenant and prevents SQL downgrade',async()=>{
 const t=await fixture();
 const native={kind:'JRC_NATIVE' as const,provenance:'VERIFIED_DEPLOYMENT' as const,hostSourceSha:'a'.repeat(40),hostImageDigest:`sha256:${'b'.repeat(64)}`,fenceProtocolVersion:1};
 const hook=createFlowOriginApproval({nativeDeployments:new Map([[t.origin,native]])});
 const service=new (PlatformService as any)(pool,Buffer.alloc(32,35),{mfaRequired:false},hook) as PlatformService;
 const result=await service.approveChatwootDestination(t.token,t.csrf,'Synthetic verified native deployment',t.org,{revision:1,mediaOrigins:[],flowExecutor:{kind:'STOCK',expectedOriginRevision:0}} as any);
 expect(result).toMatchObject({flowExecutor:{kind:'JRC_NATIVE',revision:1}});
 await expect(db.database.pool.query("UPDATE flow_executor_origins SET kind='STOCK',provenance='PLATFORM_DESTINATION_APPROVAL',host_source_sha=NULL,host_image_digest=NULL,fence_protocol_version=NULL WHERE base_url=$1",[t.origin])).rejects.toMatchObject({constraint:'flow_origin_native_downgrade'});
 const other=await seedAttendanceTenant(db.database,false);
 await db.database.pool.query("INSERT INTO chatwoot_destinations(organization_id,base_url,mode) VALUES($1,$2,'EXTERNAL')",[other.org,t.origin]);
 expect(await t.service.approveChatwootDestination(t.token,t.csrf,'Reuse native origin without declaration',other.org,{revision:1,mediaOrigins:[]})).toMatchObject({flowExecutor:{kind:'JRC_NATIVE',revision:1}});
});
it('keeps origin capability unreadable for unrelated or unapproved tenants and unwritable by tenant/auth roles',async()=>{
 const t=await fixture();
 await t.service.approveChatwootDestination(t.token,t.csrf,'Reviewed synthetic origin permissions',t.org,{revision:1,mediaOrigins:[],flowExecutor:{kind:'STOCK',expectedOriginRevision:0}} as any);
 const other=await fixture();
 expect((await queryAsTenant(db.database.pool,'jrc_app',other.org,'SELECT base_url FROM flow_executor_origins WHERE base_url=$1',[t.origin])).rows).toEqual([]);
 expect((await queryAsTenant(db.database.pool,'jrc_app',t.org,'SELECT kind FROM flow_executor_origins WHERE base_url=$1',[t.origin])).rows).toEqual([{kind:'STOCK'}]);
 await expect(queryAsTenant(db.database.pool,'jrc_app',t.org,"UPDATE flow_executor_origins SET kind='STOCK' WHERE base_url=$1",[t.origin])).rejects.toMatchObject({code:'42501'});
 for(const role of ['jrc_app','jrc_auth'])expect((await db.database.pool.query("SELECT has_table_privilege($1,'flow_executor_origins','INSERT') OR has_table_privilege($1,'flow_executor_origins','UPDATE') OR has_table_privilege($1,'flow_executor_origins','DELETE') AS allowed",[role])).rows).toEqual([{allowed:false}]);
});
it('uses current canonical platform authentication and CSRF rather than accepting an origin declaration as authority',async()=>{
 const t=await fixture();
 await expect(t.service.approveChatwootDestination(t.token,'wrong-csrf','Reviewed synthetic origin declaration',t.org,{revision:1,mediaOrigins:[],flowExecutor:{kind:'STOCK',expectedOriginRevision:0}} as any)).rejects.toMatchObject({code:'PLATFORM_FORBIDDEN'});
 await db.database.pool.query("UPDATE platform_users SET role='SUPPORT' WHERE id=$1",[t.actor]);
 await expect(t.service.approveChatwootDestination(t.token,t.csrf,'Reviewed synthetic origin declaration',t.org,{revision:1,mediaOrigins:[],flowExecutor:{kind:'STOCK',expectedOriginRevision:0}} as any)).rejects.toMatchObject({code:'PLATFORM_FORBIDDEN'});
 expect((await db.database.pool.query('SELECT * FROM flow_executor_origins WHERE base_url=$1',[t.origin])).rows).toEqual([]);
});
it('approves the operational destination of a known native origin without claiming installed executor evidence',async()=>{
 const t=await fixture(),hook=createFlowOriginApproval({knownNativeOrigins:new Set([t.origin])});
 const service=new PlatformService(pool,Buffer.alloc(32,35),{mfaRequired:false},hook);
 const result=await service.approveChatwootDestination(t.token,t.csrf,'Synthetic native destination operational approval',t.org,{revision:1,mediaOrigins:[]});
 expect(result).toMatchObject({approvalStatus:'APPROVED',flowExecutor:{kind:'JRC_NATIVE',revision:0,status:'NATIVE_EVIDENCE_REQUIRED'}});
 expect((await db.database.pool.query('SELECT kind FROM flow_executor_origins WHERE base_url=$1',[t.origin])).rows).toEqual([]);
 expect((await db.database.pool.query('SELECT approval_status FROM chatwoot_destinations WHERE organization_id=$1',[t.org])).rows).toEqual([{approval_status:'APPROVED'}]);
});
it('cannot approve a known native deployment as stock while its installed fence evidence is unavailable',async()=>{
 const t=await fixture(),hook=createFlowOriginApproval({knownNativeOrigins:new Set([t.origin])} as any);
 const service=new PlatformService(pool,Buffer.alloc(32,35),{mfaRequired:false},hook);
 await expect(service.approveChatwootDestination(t.token,t.csrf,'Synthetic native deployment awaiting image evidence',t.org,{revision:1,mediaOrigins:[],flowExecutor:{kind:'STOCK',expectedOriginRevision:0}})).rejects.toMatchObject({code:'FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED'});
 expect((await db.database.pool.query('SELECT kind FROM flow_executor_origins WHERE base_url=$1',[t.origin])).rows).toEqual([]);
 expect((await db.database.pool.query('SELECT approval_status FROM chatwoot_destinations WHERE organization_id=$1',[t.org])).rows).toEqual([{approval_status:'PENDING'}]);
});
