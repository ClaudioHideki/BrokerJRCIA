import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService,createEventRouter,createExecutionService} from '../../src/modules/automations/service.js';
import {AUTOMATION_ORIGIN} from '@jrc/contracts';
const node=(id:string,type:string,data:Record<string,unknown>={})=>({id,type,label:id,position:{x:0,y:0},data});
const edge=(source:string,target:string,port='next')=>({id:source+'-'+port,source,target,port});
const value={name:'Ana',active:false,count:0,rows:[0,false]};
const config=(target:string,extra:Record<string,unknown>)=>({configVersion:2,target,errorVariable:'error.'+target,...extra});
const graph={nodes:[node('start','start'),node('profile','data-set',config('profile.name',{valueSource:{kind:'LITERAL',value}})),
 node('wait','input',{text:'Responda para continuar',variable:'answer'}),node('pick','data-pick',config('picked',{source:'profile.name',keys:['name','rows']})),
 node('output','message',{text:'{{picked}}'}),node('error','message',{text:'Falha segura'}),node('end','end')],
 edges:[edge('start','profile'),edge('profile','wait','success'),edge('profile','error','error'),edge('wait','pick'),edge('pick','output','success'),edge('pick','error','error'),edge('output','end'),edge('error','end')]};
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);
afterAll(async()=>{await db?.dispose();});
it('persists typed values at a real wait and resumes with a replacement worker without message dispatch',async()=>{
 const t=await seedAttendanceTenant(db.database,false),other=await seedAttendanceTenant(db.database,false);
 await db.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true),($2,true)',[t.org,other.org]);
 const options={transact:db.transact,enabled:true},service=()=>createAutomationService(options);
 const draft=await service().create(t.org,{name:'Typed persistent journey',graph});
 expect(await service().validate(t.org,draft.id)).toEqual({valid:true,diagnostics:[],errors:[]});
 await service().publish(t.org,draft.id,draft.draft.revision);await service().bind(t.org,draft.id,{channelId:t.channel});
 await db.transact(t.org,tx=>tx.query("update messaging_conversations set mode='BOT',bot_public_id=$3,bot_origin_reference=$4 where organization_id=$1 and id=$2",[t.org,t.conversation,draft.id,AUTOMATION_ORIGIN]));
 const input={channelId:t.channel,conversationId:t.conversation,eventKey:randomUUID(),text:'start'};
 const routed=await createEventRouter(options).route(t.org,input);expect(routed.execution).not.toBeNull();
 expect(await createExecutionService(options).runOnce(t.org)).toMatchObject({processed:true,status:'WAITING'});
 const waiting=(await db.database.pool.query('select state,status from automation_executions where organization_id=$1 and id=$2',[t.org,routed.execution!.id])).rows[0];
 expect(waiting.state.variables['profile.name']).toEqual(value);expect(waiting.state.runtimeStateVersion).toBe(2);
 expect(waiting.state.variables).not.toHaveProperty('picked');
 // A saved draft does not replace the immutable publication already referenced by this execution.
 const changed={...graph,nodes:graph.nodes.map(item=>item.id==='profile'?{...item,data:config('profile.name',{valueSource:{kind:'LITERAL',value:{name:'changed'}}})}:item)};
 await service().save(t.org,draft.id,{name:draft.name,graph:changed,revision:draft.draft.revision});
 await expect(service().get(other.org,draft.id)).rejects.toMatchObject({code:'AUTOMATION_NOT_FOUND'});
 const replacedRouter=createEventRouter(options),reply={...input,eventKey:randomUUID(),text:'continue'};
 expect(await replacedRouter.route(t.org,reply)).toMatchObject({resumed:true});
 expect(await replacedRouter.route(t.org,reply)).toEqual({duplicate:true,execution:null});
 expect(await createExecutionService(options).runOnce(t.org)).toMatchObject({processed:true,status:'COMPLETED'});
 const done=(await db.database.pool.query('select state,version from automation_executions where organization_id=$1 and id=$2',[t.org,routed.execution!.id])).rows[0];
 expect(done).toMatchObject({version:1,state:{variables:{'profile.name':value,picked:{name:'Ana',rows:[0,false]},answer:'continue'}}});
 const outbox=(await db.database.pool.query('select kind,payload,status from automation_outbox where organization_id=$1 and execution_id=$2 order by ordinal',[t.org,routed.execution!.id])).rows;
 expect(outbox).toHaveLength(2);expect(outbox.map(item=>item.kind)).toEqual(['SEND_TEXT','SEND_TEXT']);
 expect(outbox.map(item=>item.payload.text)).toEqual(['Responda para continuar','{"name":"Ana","rows":[0,false]}']);
 expect(outbox.every(item=>item.status==='PENDING')).toBe(true);
 expect(await createExecutionService(options).runOnce(t.org)).toEqual({processed:false});
 expect((await db.transact(other.org,tx=>tx.query('select id from automation_executions where id=$1',[routed.execution!.id]))).rows).toEqual([]);
},60000);
