import {describe,expect,it,vi} from 'vitest';
import * as availability from '../../src/modules/automations/availability.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';

const now=new Date('2026-09-29T12:00:00Z');
const workers=['MESSAGING_WORKER','AUTOMATION_WORKER','AUTOMATION_IO_WORKER','SCHEDULER'];
const fresh=()=>workers.map(component=>({component,status:'UP',observedAt:now}));

describe('automation publication readiness',()=>{
 it('does not leave availability requests waiting indefinitely for Redis',async()=>{
  vi.useFakeTimers();
  try{
   const ready=availability.createAutomationRuntimeReadiness({transact:async()=>{throw new Error('NOT_REACHED');},schemaCurrent:async()=>true,probeRedis:()=>new Promise<boolean>(()=>{}),now:()=>now});
   let result:boolean|undefined;void ready('tenant').then(value=>{result=value;});
   await vi.advanceTimersByTimeAsync(2000);expect(result).toBe(false);
  }finally{vi.useRealTimers();}
 });
 it('requires database schema, Redis and all four fresh operational workers',async()=>{
  let beats=fresh(),schema=true,redis=true;
  const transact=async<T>(_org:string,work:(tx:TenantTransaction)=>Promise<T>)=>work({query:async()=>({rows:beats,rowCount:beats.length})} as unknown as TenantTransaction);
  const ready=availability.createAutomationRuntimeReadiness({transact,schemaCurrent:async()=>schema,probeRedis:async()=>redis,now:()=>now});
  expect(await ready('tenant')).toBe(true);
  beats=beats.filter(beat=>beat.component!=='SCHEDULER');expect(await ready('tenant')).toBe(false);
  beats=fresh();beats[1]!.observedAt=new Date(now.getTime()-46000);expect(await ready('tenant')).toBe(false);
  beats=fresh();beats[1]!.status='DEGRADED';expect(await ready('tenant')).toBe(false);
  beats=fresh();schema=false;expect(await ready('tenant')).toBe(false);
  schema=true;redis=false;expect(await ready('tenant')).toBe(false);
 });
 it('returns unavailable on dependency errors and probes the network outside the tenant transaction',async()=>{
  let inTransaction=false;
  const transact=async<T>(_org:string,work:(tx:TenantTransaction)=>Promise<T>)=>{inTransaction=true;try{return await work({query:async()=>({rows:fresh(),rowCount:4})} as unknown as TenantTransaction);}finally{inTransaction=false;}};
  const probeRedis=vi.fn(async()=>{expect(inTransaction).toBe(false);throw new Error('REDIS_UNAVAILABLE');});
  const ready=availability.createAutomationRuntimeReadiness({transact,schemaCurrent:async()=>true,probeRedis,now:()=>now});
  expect(await ready('tenant')).toBe(false);expect(probeRedis).toHaveBeenCalledOnce();
 });
});
