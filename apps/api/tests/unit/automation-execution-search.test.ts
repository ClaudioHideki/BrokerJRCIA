import {describe,expect,it,vi} from 'vitest';
import {createExecutionService} from '../../src/modules/automations/service.js';
import {AutomationExecutionPageSchema} from '@jrc/contracts';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const filters={from:'2030-01-01T00:00:00.000Z',to:'2030-01-02T00:00:00.000Z',pageSize:1,status:'FAILED' as const};
const row={schemaVersion:1,id,organizationId:org,automationId:id,version:1,bindingId:id,channelId:id,status:'FAILED',currentNodeId:'capture',correlationId:id,startedAt:'2030-01-01T12:00:00.000Z',cursorStartedAt:'2030-01-01T12:00:00.123456Z',updatedAt:'2030-01-01T12:00:01.000Z',completedAt:'2030-01-01T12:00:01.000Z',durationMs:1000,errorCode:'AUTOMATION_STEP_LIMIT',conversationRef:id};
describe('bounded execution search',()=>{
 it('pages with a stable tie-breaker while computing metrics over the entire filtered interval',async()=>{
  const calls:Array<{sql:string;params:readonly unknown[]}>=[];
  const tx={query:async(sql:string,params:readonly unknown[]=[])=>{calls.push({sql,params});return sql.includes('count(*)')
   ?{rows:[{total:15,completed:0,active:0,failed:15,unknown:0,canceled:0,handoff:0}],rowCount:1}
   :{rows:[row,{...row,id:'33333333-3333-4333-8333-333333333333'}],rowCount:2};}};
  const service=createExecutionService({repository:{listExecutions:async()=>[]} as never,transact:async(_org,work)=>work(tx as never)});
  const result=AutomationExecutionPageSchema.parse(await service.list(org,undefined,filters));
  expect(result).toMatchObject({data:[{id,version:1,durationMs:1000}],metrics:{total:15,failed:15,completionRate:0},period:{from:filters.from,to:filters.to}});
  expect(result.nextCursor).toEqual(expect.any(String));
  await expect(Promise.resolve().then(()=>service.list('99999999-9999-4999-8999-999999999999',undefined,{...filters,cursor:result.nextCursor!}))).rejects.toMatchObject({code:'AUTOMATION_CURSOR_INVALID'});
  await expect(Promise.resolve().then(()=>service.list(org,undefined,{...filters,status:'COMPLETED',cursor:result.nextCursor!}))).rejects.toMatchObject({code:'AUTOMATION_CURSOR_INVALID'});
  expect(calls.every(call=>call.params[0]===org&&call.sql.includes('organization_id=$1'))).toBe(true);
  expect(calls.find(call=>!call.sql.includes('count(*)'))?.sql).toContain('order by e.started_at desc,e.id desc');
  calls.length=0;await service.list(org,undefined,{...filters,cursor:result.nextCursor!});
  expect(calls.find(call=>!call.sql.includes('count(*)'))?.params).toContain('2030-01-01T12:00:00.123456Z');
  expect(calls.find(call=>call.sql.includes('count(*)'))?.sql).not.toContain('(e.started_at,e.id)<');
 });
 it('rejects malformed cursors, changed filters and periods above31days before opening a transaction',async()=>{
  const transact=vi.fn(),service=createExecutionService({transact});
  for(const query of [{...filters,cursor:'invalid'},{...filters,to:'2031-01-01T00:00:00Z'},{...filters,from:'2030-02-30T00:00:00Z'},{...filters,pageSize:201}])
   await expect(Promise.resolve().then(()=>service.list(org,undefined,query))).rejects.toThrow();
  expect(transact).not.toHaveBeenCalled();
 });
 it('returns known zero totals and a null completion rate for an empty result instead of fabricating100percent',async()=>{
  const service=createExecutionService({repository:{listExecutions:async()=>[]} as never,transact:async(_org,work)=>work({query:async(sql:string)=>({rows:sql.includes('count(*)')?[{total:0,completed:0,active:0,failed:0,unknown:0,canceled:0,handoff:0}]:[],rowCount:1})} as never)});
  expect(await service.list(org,undefined,filters)).toMatchObject({data:[],nextCursor:null,metrics:{total:0,completionRate:null}});
 });
});
