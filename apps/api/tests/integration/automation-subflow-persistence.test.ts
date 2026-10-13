import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService} from '../../src/modules/automations/service.js';
import {AUTOMATION_ORIGIN,type AutomationGraphV1} from '@jrc/contracts';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string)=>({id:source+'-next',source,target,port:'next'});
const graph=(middle:ReturnType<typeof node>[],start:Record<string,unknown>={}):AutomationGraphV1=>({
 nodes:[node('start','start',start),...middle,node('end','end')],edges:[node('start','start'),...middle].map((item,at)=>edge(item.id,middle[at]?.id??'end'))});
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});

it('persists a fixed child at a wait, resumes after publication/archive and replacement worker, then returns shared values to the parent',async()=>{
 const t=await seedAttendanceTenant(db.database,false),other=await seedAttendanceTenant(db.database,false);
 await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true),($2,true)',[t.org,other.org]);
 const options={transact:db.transact,enabled:true},service=()=>createAutomationService(options);
 const childGraph=graph([node('answer','input',{text:'Nome?',variable:'answer'}),node('child-message','message',{text:'Filha v1 {{answer}}'})]);
 const child=await service().create(t.org,{name:'Child',graph:childGraph});await service().publish(t.org,child.id,child.draft.revision);
 const parentGraph=graph([node('call','subflow',{automationId:child.id,version:1,input:{typed:{active:false,count:0}},timeoutMs:30000}),node('parent-message','message',{text:'Pai {{answer}}'})]);
 const parent=await service().create(t.org,{name:'Parent',graph:parentGraph});const parentVersion=await service().publish(t.org,parent.id,parent.draft.revision);
 expect(parentVersion.graph.nodes[0]!.data.dependencyPolicyVersion).toBe(1);expect((await service().get(t.org,parent.id)).draft.graph.nodes[0]!.data.dependencyPolicyVersion).toBeUndefined();
 const catalog=await service().subflowCatalog(t.org,parent.id);expect(catalog.data).toContainEqual(expect.objectContaining({automationId:child.id,version:1,runtimeStateVersion:2}));
 expect(catalog.data.every(item=>!('graph' in item)&&item.automationId!==parent.id)).toBe(true);
 await expect(service().subflowCatalog(other.org,parent.id)).rejects.toMatchObject({code:'AUTOMATION_NOT_FOUND'});
 await service().bind(t.org,parent.id,{channelId:t.channel});
 await db.transact(t.org,tx=>tx.query("update messaging_conversations set mode='BOT',bot_public_id=$3,bot_origin_reference=$4 where organization_id=$1 and id=$2",[t.org,t.conversation,parent.id,AUTOMATION_ORIGIN]));
 const event={channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:'start'},router=createEventRouter(options);
 const routed=await router.route(t.org,event);expect(routed.execution).not.toBeNull();
 expect(await createExecutionService(options).runOnce(t.org)).toMatchObject({processed:true,status:'WAITING'});
 const waiting=(await db.database.pool.query('select state from automation_executions where organization_id=$1 and id=$2',[t.org,routed.execution!.id])).rows[0].state;
 expect(waiting).toMatchObject({automationId:child.id,version:1,variables:{typed:{active:false,count:0}},stack:[{automationId:parent.id,version:1,returnNodeId:'parent-message'}]});
 const changed=await service().save(t.org,child.id,{name:child.name,graph:graph([node('changed','message',{text:'NEW_VERSION_MUST_NOT_RUN'})]),revision:child.draft.revision});
 expect((await service().publish(t.org,child.id,changed.draft.revision)).version).toBe(2);
 await service().setArchived(t.org,child.id,true);
 await expect(service().simulate(t.org,parent.id,{text:'new'})).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_ARCHIVED'});
 expect(await createEventRouter(options).route(t.org,{...event,eventKey:randomUUID(),text:'Ana'})).toMatchObject({resumed:true});
 expect(await createExecutionService(options).runOnce(t.org)).toMatchObject({processed:true,status:'COMPLETED'});
 const texts=(await db.database.pool.query("select payload->>'text' as text from automation_outbox where organization_id=$1 and execution_id=$2 order by ordinal",[t.org,routed.execution!.id])).rows.map(item=>item.text);
 expect(texts).toEqual(['Nome?','Filha v1 Ana','Pai Ana']);
 expect((await db.transact(other.org,tx=>tx.query('select id from automation_executions where id=$1',[routed.execution!.id]))).rows).toEqual([]);
 const preserved=(await db.database.pool.query('select graph,checksum from automation_versions where organization_id=$1 and automation_id=$2 and version=1',[t.org,parent.id])).rows[0];
 expect(preserved).toEqual({graph:parentVersion.graph,checksum:parentVersion.checksum});
},60000);

it('keeps a historical unmarked root through nine persisted child frames and an archived fixed child after restart',async()=>{
 const t=await seedAttendanceTenant(db.database,false);await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)',[t.org]);
 const ids=Array.from({length:10},()=>randomUUID()),rootId=ids[0]!;
 const graphs=ids.map((_id,at)=>graph(at<9?[node('call','subflow',{automationId:ids[at+1],version:1,timeoutMs:30000})]:[node('answer','input',{text:'Nome histórico?',variable:'answer'})],at===4?{dependencyPolicyVersion:1}:{}));
 // Persist historical immutable rows with their real absence of a root marker.
 for(const [at,id] of ids.entries()){
  await db.database.pool.query("insert into automation_definitions(organization_id,id,name,draft_graph) values($1,$2::uuid,$2::text,$3)",[t.org,id,JSON.stringify(graphs[at])]);
  await db.database.pool.query('insert into automation_versions(organization_id,automation_id,version,graph,checksum,runtime_state_version) values($1,$2,1,$3,$4,2)',[t.org,id,JSON.stringify(graphs[at]),'a'.repeat(64)]);
  await db.database.pool.query("update automation_definitions set active_version=1,lifecycle_status='PUBLISHED' where organization_id=$1 and id=$2",[t.org,id]);
 }
 const options={transact:db.transact,enabled:true},service=createAutomationService(options);
 await service.bind(t.org,rootId,{channelId:t.channel});
 await db.transact(t.org,tx=>tx.query("update messaging_conversations set mode='BOT',bot_public_id=$3,bot_origin_reference=$4 where organization_id=$1 and id=$2",[t.org,t.conversation,rootId,AUTOMATION_ORIGIN]));
 const event={channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:'start'};
 const routed=await createEventRouter(options).route(t.org,event);expect(routed.execution).not.toBeNull();
 expect(await createExecutionService(options).runOnce(t.org)).toMatchObject({status:'WAITING'});
 expect((await db.database.pool.query('select jsonb_array_length(state->\'stack\') as depth from automation_executions where id=$1',[routed.execution!.id])).rows[0].depth).toBe(9);
 await service.setArchived(t.org,ids[3]!,true);
 await expect(service.simulate(t.org,rootId,{text:'new'})).rejects.toMatchObject({code:'AUTOMATION_SUBFLOW_ARCHIVED'});
 expect(await createEventRouter(options).route(t.org,{...event,eventKey:randomUUID(),text:'Ana'})).toMatchObject({resumed:true});
 expect(await createExecutionService(options).runOnce(t.org)).toMatchObject({status:'COMPLETED'});
 const done=(await db.database.pool.query('select state from automation_executions where id=$1',[routed.execution!.id])).rows[0].state;
 expect(done).toMatchObject({automationId:rootId,version:1,stack:[],variables:{answer:'Ana'}});
 expect((await db.database.pool.query('select graph,checksum from automation_versions where automation_id=$1 and version=1',[rootId])).rows[0]).toEqual({graph:graphs[0],checksum:'a'.repeat(64)});
},60000);
