import { describe, expect, it, vi } from 'vitest';
import { createObservabilityService, type ObservabilityRepository } from '../../src/modules/observability/service.js';

describe('operational observability',()=>{
 it('shows unresolved QR identity facts instead of reporting a healthy intake',async()=>{
  const now=new Date(),repository:ObservabilityRepository={snapshot:vi.fn().mockResolvedValue({queueDepth:0,oldestOutboxSeconds:null,failedExecutions:0,unknownExecutions:0,metaReady:1,evolutionReady:1,chatwootReady:1,chatwootDegraded:0,integrationFailures:0,integrationUnknown:0,identityPending:2}),
   heartbeats:async()=>['MESSAGING_WORKER','AUTOMATION_WORKER','AUTOMATION_IO_WORKER','SCHEDULER'].map(component=>({component,status:'UP' as const,observedAt:now}))};
  const health=await createObservabilityService({repository,transact:async(_org,work)=>work({} as never),probeRedis:async()=>true,now:()=>now}).health('11111111-1111-4111-8111-111111111111');
  expect(health.components.find(item=>item.key==='QR_IDENTITY_PENDING')).toMatchObject({state:'DEGRADED',metric:2,code:'QR_IDENTITY_RECONCILIATION_REQUIRED'});
 });
 it.each([{failed:179,unknown:0,key:'INTEGRATION_FAILURES',code:'INTEGRATION_JOBS_FAILED',metric:179},
  {failed:0,unknown:1,key:'INTEGRATION_UNCERTAINTY',code:'INTEGRATION_OUTCOME_UNKNOWN',metric:1}])('reports integration delivery failures separately from healthy workers: $code',async input=>{
  const now=new Date(),repository:ObservabilityRepository={snapshot:vi.fn().mockResolvedValue({queueDepth:0,oldestOutboxSeconds:null,failedExecutions:0,unknownExecutions:0,metaReady:1,evolutionReady:1,chatwootReady:1,chatwootDegraded:0,integrationFailures:input.failed,integrationUnknown:input.unknown}),
   heartbeats:async()=>['MESSAGING_WORKER','AUTOMATION_WORKER','AUTOMATION_IO_WORKER','SCHEDULER'].map(component=>({component,status:'UP' as const,observedAt:now}))};
  const health=await createObservabilityService({repository,transact:async(_org,work)=>work({} as never),probeRedis:async()=>true,schemaCurrent:async()=>true,now:()=>now}).health('11111111-1111-4111-8111-111111111111');
  expect(health.overall).toBe('DEGRADED');
  expect(health.components.find(item=>item.key===input.key)).toMatchObject({state:'DEGRADED',code:input.code,metric:input.metric});
  expect(health.alerts).toContainEqual({component:input.key,code:input.code,state:'DEGRADED'});
 });
 it('identifies an intentionally paused worker instead of calling its heartbeat healthy',async()=>{
  const now=new Date(),repository:ObservabilityRepository={snapshot:async()=>({queueDepth:0,oldestOutboxSeconds:null,failedExecutions:0,unknownExecutions:0,metaReady:0,evolutionReady:0,chatwootReady:0,chatwootDegraded:0,integrationFailures:0,integrationUnknown:0}),heartbeats:async()=>[{component:'AUTOMATION_WORKER',status:'DEGRADED',observedAt:now,detailCode:'AUTOMATION_RUNTIME_DISABLED'}]};
  const health=await createObservabilityService({repository,transact:async(_org,work)=>work({} as never),probeRedis:async()=>true,now:()=>now}).health('tenant');
  expect(health.components.find(item=>item.key==='AUTOMATION_WORKER')).toMatchObject({state:'DEGRADED',code:'AUTOMATION_RUNTIME_DISABLED'});
 });
 it('separa componentes, detecta heartbeat vencido e produz alertas locais',async()=>{const now=new Date('2026-09-21T15:00:00Z'),repository:ObservabilityRepository={
  snapshot:vi.fn().mockResolvedValue({queueDepth:12,oldestOutboxSeconds:420,failedExecutions:1,unknownExecutions:2,metaReady:1,evolutionReady:0,chatwootReady:1,chatwootDegraded:1}),
  heartbeats:vi.fn().mockResolvedValue([{component:'MESSAGING_WORKER',status:'UP',observedAt:new Date(now.getTime()-5_000)},{component:'AUTOMATION_WORKER',status:'UP',observedAt:new Date(now.getTime()-60_000)},{component:'AUTOMATION_IO_WORKER',status:'UP',observedAt:new Date(now.getTime()-5_000)},{component:'SCHEDULER',status:'UP',observedAt:new Date(now.getTime()-5_000)}]),
 };const service=createObservabilityService({repository,transact:async(_org,work)=>work({} as never),probeRedis:async()=>true,schemaCurrent:async()=>true,now:()=>now});
  const health=await service.health('11111111-1111-4111-8111-111111111111');
  expect(health.overall).toBe('DOWN');expect(health.components.find(item=>item.key==='AUTOMATION_WORKER')).toMatchObject({state:'DOWN',code:'WORKER_HEARTBEAT_STALE'});
  expect(health.components.find(item=>item.key==='SCHEMA')).toMatchObject({state:'UP',code:'SCHEMA_REQUIRED_OBJECTS_PRESENT'});
  expect(health.components.find(item=>item.key==='OUTBOX_AGE')).toMatchObject({state:'DEGRADED',metric:420});expect(health.alerts.map(item=>item.code)).toContain('UNKNOWN_GROWTH');
 });
 it('não declara provider configurado como conectado sem observação',async()=>{const repository:ObservabilityRepository={snapshot:async()=>({queueDepth:0,oldestOutboxSeconds:null,failedExecutions:0,unknownExecutions:0,metaReady:0,evolutionReady:0,chatwootReady:0,chatwootDegraded:0,integrationFailures:0,integrationUnknown:0}),heartbeats:async()=>[]};const health=await createObservabilityService({repository,transact:async(_org,work)=>work({} as never),probeRedis:async()=>false,schemaCurrent:async()=>false}).health('11111111-1111-4111-8111-111111111111');expect(health.components.find(item=>item.key==='META')?.state).toBe('UNKNOWN');expect(health.components.find(item=>item.key==='SCHEMA')?.code).toBe('SCHEMA_INCOMPATIBLE');});
});
