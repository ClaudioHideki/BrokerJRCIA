import {afterAll,beforeAll,expect,it} from 'vitest';
import {attendanceDatabase,seedAttendanceTenant} from './helpers/attendance.js';
import {createAutomationService} from '../../src/modules/automations/service.js';
import {executeAutomation} from '../../src/modules/automations/engine.js';
import type {FlowNode} from '@jrc/contracts';
const node=(id:string,type:string,data:Record<string,unknown>={}):FlowNode=>({id,type,label:id,position:{x:0,y:0},data});
const graph={nodes:[node('start','start'),node('switch','switch',{switchVersion:1,variable:'message',cases:[{id:'text',label:'Texto',value:'1'},{id:'number',label:'Número',value:1}]}),
 node('matched','message',{text:'Texto selecionado'}),node('end','end')],edges:[{id:'s',source:'start',target:'switch',port:'next'},
 {id:'t',source:'switch',target:'matched',port:'case-text'},{id:'n',source:'switch',target:'end',port:'case-number'},
 {id:'d',source:'switch',target:'end',port:'default'},{id:'e',source:'matched',target:'end',port:'next'}]};
let db:Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async()=>{db=await attendanceDatabase();},60000);afterAll(async()=>{await db?.dispose();});
it('pins typed case values in immutable publications and leaves the inbox unbound',async()=>{
 const t=await seedAttendanceTenant(db.database,false);
 await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true) ON CONFLICT(organization_id) DO UPDATE SET enabled=true',[t.org]);
 const service=createAutomationService({transact:db.transact,enabled:true});
 const draft=await service.create(t.org,{name:'Synthetic switch',graph});
 expect(await service.validate(t.org,draft.id)).toMatchObject({valid:true});
 await service.publish(t.org,draft.id,draft.draft.revision);
 const edited={...graph,nodes:graph.nodes.map(n=>n.id==='matched'?{...n,data:{text:'Nova versão'}}:n)};
 await service.save(t.org,draft.id,{name:'Synthetic switch',graph:edited,revision:draft.draft.revision});
 const published=await db.transact(t.org,tx=>tx.query<{graph:typeof graph;runtime_state_version:1|2}>(
  'SELECT graph,runtime_state_version FROM automation_versions WHERE organization_id=$1 AND automation_id=$2 AND version=1',[t.org,draft.id]));
 const result=await executeAutomation({automationId:draft.id,version:1,graph:published.rows[0]!.graph,runtimeStateVersion:published.rows[0]!.runtime_state_version},
  {text:'1',eventType:'MESSAGE',now:new Date()},async()=>{throw new Error('No subflow');});
 expect(result.effects.map(e=>e.payload.text)).toEqual(['Texto selecionado']);
 expect((await db.database.pool.query('SELECT id FROM automation_bindings WHERE organization_id=$1 AND automation_id=$2',[t.org,draft.id])).rows).toHaveLength(0);
 const other=await seedAttendanceTenant(db.database,false);
 await expect(service.get(other.org,draft.id)).rejects.toMatchObject({code:'AUTOMATION_NOT_FOUND'});
});
