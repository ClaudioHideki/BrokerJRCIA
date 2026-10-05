import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {triageFlow} from '@jrc/contracts';
import {createFlowService} from '../../src/modules/flows/service.js';
import {createLegacyFlowMigrationService} from '../../src/modules/automations/legacy-migration.js';
import {createPostgresMessagingRepository} from '../../src/modules/messaging/repository.js';
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);afterAll(async()=>{await db?.dispose();});
const graph=(data:Record<string,unknown>)=>({nodes:[{id:'s',type:'start',label:'s',position:{x:0,y:0},data:{}},{id:'h',type:'handoff',label:'h',position:{x:200,y:0},data}],edges:[{id:'e',source:'s',target:'h',port:'next'}]});
const bind=async(t:Awaited<ReturnType<typeof seedAttendanceTenant>>)=>{await db.database.pool.query("UPDATE automation_definitions SET active_version=1,lifecycle_status='PUBLISHED' WHERE organization_id=$1 AND id=$2",[t.org,t.automation]);return db.transact(t.org,tx=>createPostgresMessagingRepository().setChannelBot(tx,{organizationId:t.org,channelId:t.channel,botPublicId:t.automation,botOriginReference:'jrc-automation-v2',expectedOwnerRevision:0}));};
it('alternate channel bot activation rejects another tenant destination despite matching numeric account/inbox',async()=>{
 const a=await seedAttendanceTenant(db.database),b=await seedAttendanceTenant(db.database);
 await db.database.pool.query('UPDATE automation_versions SET graph=$3 WHERE organization_id=$1 AND automation_id=$2',[a.org,a.automation,JSON.stringify(graph({handoffVersion:1,destination:{integrationId:b.integration,destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9},target:{teamId:4,agentId:null}}))]);
 await expect(bind(a)).rejects.toMatchObject({code:'ATTENDANCE_HANDOFF_CONTEXT_CHANGED'});
});
it('alternate channel bot activation rejects stale credential references',async()=>{
 const t=await seedAttendanceTenant(db.database);
 await db.database.pool.query('UPDATE automation_versions SET graph=$3 WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation,JSON.stringify(graph({handoffVersion:1,destination:{integrationId:t.integration,destinationRevision:1,credentialRevision:2,accountId:7,inboxId:9},target:{teamId:4,agentId:null}}))]);
 await expect(bind(t)).rejects.toMatchObject({code:'ATTENDANCE_HANDOFF_CONTEXT_CHANGED'});
});
it('does not activate a historical unconfigured handoff through an alternate path',async()=>{
 const t=await seedAttendanceTenant(db.database);await db.database.pool.query('UPDATE automation_versions SET graph=$3 WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation,JSON.stringify(graph({}))]);
 await expect(bind(t)).rejects.toMatchObject({code:'ATTENDANCE_HANDOFF_DESTINATION_REQUIRED'});
});
it('admits a matching locally scoped destination while leaving remote proof to dispatch',async()=>{
 const t=await seedAttendanceTenant(db.database);
 await db.database.pool.query('UPDATE automation_versions SET graph=$3 WHERE organization_id=$1 AND automation_id=$2',[t.org,t.automation,JSON.stringify(graph({handoffVersion:1,destination:{integrationId:t.integration,destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9},target:{teamId:4,agentId:null}}))]);
 await expect(bind(t)).resolves.toMatchObject({botPublicId:t.automation});
});

it('legacy cutover cannot bypass missing native destination and leaves the old owner intact',async()=>{
 const t=await seedAttendanceTenant(db.database);
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true) ON CONFLICT(organization_id) DO UPDATE SET enabled=true',[t.org]);
 const flows=createFlowService({transact:db.transact}),flow=await flows.create(t.org,{name:'Legacy triage',graph:triageFlow()});
 await flows.publish(t.org,flow.id,flow.revision);
 await db.transact(t.org,tx=>createPostgresMessagingRepository().setChannelBot(tx,{organizationId:t.org,channelId:t.channel,botPublicId:flow.id,botOriginReference:'jrc-flows-native',expectedOwnerRevision:0}));
 await expect(createLegacyFlowMigrationService({transact:db.transact}).migrateBatch(t.org)).rejects.toMatchObject({code:'ATTENDANCE_HANDOFF_DESTINATION_REQUIRED'});
 expect((await db.database.pool.query('SELECT bot_public_id,bot_origin_reference FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]).toEqual({bot_public_id:flow.id,bot_origin_reference:'jrc-flows-native'});
});
