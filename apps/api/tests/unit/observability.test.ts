import { describe, expect, it, vi } from 'vitest';
import { createObservabilityService, type ObservabilityRepository } from '../../src/modules/observability/service.js';

describe('operational observability',()=>{
 it('separa componentes, detecta heartbeat vencido e produz alertas locais',async()=>{const now=new Date('2026-09-21T15:00:00Z'),repository:ObservabilityRepository={
  snapshot:vi.fn().mockResolvedValue({queueDepth:12,oldestOutboxSeconds:420,failedExecutions:1,unknownExecutions:2,metaReady:1,evolutionReady:0,chatwootReady:1,chatwootDegraded:1}),
  heartbeats:vi.fn().mockResolvedValue([{component:'MESSAGING_WORKER',status:'UP',observedAt:new Date(now.getTime()-5_000)},{component:'AUTOMATION_WORKER',status:'UP',observedAt:new Date(now.getTime()-60_000)},{component:'AUTOMATION_IO_WORKER',status:'UP',observedAt:new Date(now.getTime()-5_000)},{component:'SCHEDULER',status:'UP',observedAt:new Date(now.getTime()-5_000)}]),
 };const service=createObservabilityService({repository,transact:async(_org,work)=>work({} as never),probeRedis:async()=>true,schemaCurrent:async()=>true,now:()=>now});
  const health=await service.health('11111111-1111-4111-8111-111111111111');
  expect(health.overall).toBe('DOWN');expect(health.components.find(item=>item.key==='AUTOMATION_WORKER')).toMatchObject({state:'DOWN',code:'WORKER_HEARTBEAT_STALE'});
  expect(health.components.find(item=>item.key==='OUTBOX_AGE')).toMatchObject({state:'DEGRADED',metric:420});expect(health.alerts.map(item=>item.code)).toContain('UNKNOWN_GROWTH');
 });
 it('não declara provider configurado como conectado sem observação',async()=>{const repository:ObservabilityRepository={snapshot:async()=>({queueDepth:0,oldestOutboxSeconds:null,failedExecutions:0,unknownExecutions:0,metaReady:0,evolutionReady:0,chatwootReady:0,chatwootDegraded:0}),heartbeats:async()=>[]};const health=await createObservabilityService({repository,transact:async(_org,work)=>work({} as never),probeRedis:async()=>false,schemaCurrent:async()=>false}).health('11111111-1111-4111-8111-111111111111');expect(health.components.find(item=>item.key==='META')?.state).toBe('UNKNOWN');expect(health.components.find(item=>item.key==='SCHEMA')?.code).toBe('SCHEMA_INCOMPATIBLE');});
});
