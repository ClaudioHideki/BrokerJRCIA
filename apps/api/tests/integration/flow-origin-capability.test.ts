import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {seedAttendanceTenant} from './helpers/attendance.js';
import {attendanceDatabaseBeforeFlow as attendanceDatabase} from './helpers/flow-promotion-test-fixture.js';
import {createIntegrationSecrets} from '../../src/modules/integrations/secrets.js';
import {createFlowDelegationService} from '../../src/modules/flows/delegation/service.js';

let db:Awaited<ReturnType<typeof attendanceDatabase>>;
const vault=createIntegrationSecrets(Buffer.alloc(32,33).toString('base64'));
const graph={nodes:[{id:'s',type:'start',label:'Start',position:{x:0,y:0},data:{}},{id:'e',type:'end',label:'End',position:{x:1,y:0},data:{}}],edges:[{id:'next',source:'s',target:'e',port:'next'}]};
beforeAll(async()=>{db=await attendanceDatabase();await db.database.pool.query(await readFile(new URL('../../drizzle/migrations/0053_flow_delegation.sql',import.meta.url),'utf8'));});
afterAll(async()=>{await db?.dispose();});
async function fixture(){
 const t=await seedAttendanceTenant(db.database);
 const actor=(await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'",[t.org])).rows[0]!.user_id;
 const authVersion=(await db.database.pool.query('SELECT auth_version FROM users WHERE id=$1',[actor])).rows[0]!.auth_version;
 await db.database.pool.query('UPDATE chatwoot_accounts SET encrypted_token=$2 WHERE organization_id=$1',[t.org,vault.encrypt(`${t.org}:chatwoot-account`,'synthetic-token')]);
 await db.database.pool.query("UPDATE chatwoot_destinations SET approval_status='APPROVED' WHERE organization_id=$1",[t.org]);
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true) ON CONFLICT(organization_id) DO UPDATE SET enabled=true',[t.org]);
 return {...t,principal:{organizationId:t.org,actorId:actor,authVersion},service:createFlowDelegationService({transact:db.transact,automation:{enabled:true}})};
}

// Prepared RED: current implementation accepts this first tenant classification
// and therefore permits a native origin to bypass the eleven-path fence.
it('rejects tenant-supplied STOCK even on the first profile approval instead of treating Account token or EXTERNAL as executor evidence',async()=>{
 const t=await fixture();
 await expect(t.service.configureExecutorProfile(t.principal,{integrationId:t.integration,hostKind:'STOCK',expectedRevision:0})).rejects.toMatchObject({name:'ZodError'});
 expect((await db.database.pool.query('SELECT * FROM flow_executor_profiles WHERE organization_id=$1',[t.org])).rows).toEqual([]);
});

it('requires verified origin capability for profile activation but leaves canonical scoped first-party drafting usable',async()=>{
 const t=await fixture();
 await expect(t.service.configureExecutorProfile(t.principal,{integrationId:t.integration,expectedRevision:0})).rejects.toMatchObject({code:'FLOW_ORIGIN_CAPABILITY_REQUIRED'});
 const session=await t.service.issueBrokerSession(t.principal,{integrationIds:[t.integration],scopes:['flow:read','flow:edit','flow:publish']});
 const access={organizationId:t.org,token:session.token};
 const draft=await t.service.create(access,{name:'First-party draft without executor assertion',graph,integrationIds:[t.integration]},randomUUID());
 const saved=await t.service.save(access,draft.id,{name:'Edited before transport activation',graph,revision:1,expectedScopeRevision:1});
 expect(saved.draft.revision).toBe(2);
 expect(await t.service.publish(access,draft.id,{revision:2,expectedScopeRevision:1})).toMatchObject({automationId:draft.id,version:1});
 expect((await db.database.pool.query('SELECT * FROM automation_bindings WHERE organization_id=$1',[t.org])).rows).toEqual([]);
});
