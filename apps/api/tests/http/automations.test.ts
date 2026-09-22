import { afterEach,describe,expect,it,vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import type { LegacyFlowMigrationService } from '../../src/modules/automations/legacy-migration.js';
import type { AutomationService, createExecutionService } from '../../src/modules/automations/service.js';

const secret='automation-routes-secret-with-at-least-32-bytes',org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const graph={nodes:[{id:'start',type:'start',label:'Início',position:{x:0,y:0},data:{}},{id:'end',type:'end',label:'Fim',position:{x:1,y:1},data:{}}],edges:[{id:'e',source:'start',target:'end',port:'next'}]};
describe('automation v2 routes',()=>{const apps:Array<ReturnType<typeof buildApp>>=[];afterEach(async()=>Promise.all(apps.splice(0).map(app=>app.close())));
  it('exposes canonical CRUD and revalidates write roles',async()=>{let role:'OWNER'|'VIEWER'='OWNER';const automation={id,organizationId:org,name:'Atendimento',lifecycleStatus:'DRAFT',draft:{revision:1,graph},activeVersion:null,updatedAt:'2030-01-01T00:00:00.000Z'};
    const service={status:vi.fn().mockReturnValue({enabled:true,engine:'AUTOMATION_RUNTIME_V2'}),list:vi.fn().mockResolvedValue({data:[automation]}),create:vi.fn().mockResolvedValue(automation)} as unknown as AutomationService;
    const executions={} as ReturnType<typeof createExecutionService>,app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service,executions}});apps.push(app);
    const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
    expect((await app.inject({method:'GET',url:'/v1/automations',headers:{authorization}})).json().data[0].id).toBe(id);
    expect((await app.inject({method:'POST',url:'/v1/automations',headers:{authorization,'idempotency-key':'create'},payload:{name:'Atendimento',graph}})).statusCode).toBe(201);
    role='VIEWER';expect((await app.inject({method:'POST',url:'/v1/automations',headers:{authorization,'idempotency-key':'blocked'},payload:{name:'Atendimento',graph}})).statusCode).toBe(403);
  });
  it('authorizes tenant migration operations and requires idempotency keys',async()=>{let role:'OWNER'|'ADMIN'|'VIEWER'='OWNER';const migration={
    status:vi.fn().mockResolvedValue({data:[],metrics:{}}),
    migrateBatch:vi.fn().mockResolvedValue({organizationId:org,count:0,nextCursor:null,items:[]}),
    cutover:vi.fn().mockResolvedValue({flowId:id,status:'MANAGED',results:[]}),
    rollback:vi.fn().mockResolvedValue({flowId:id,status:'ROLLED_BACK',channels:0}),
  } as unknown as LegacyFlowMigrationService;
    const service={status:vi.fn().mockReturnValue({enabled:true,engine:'AUTOMATION_RUNTIME_V2'})} as unknown as AutomationService;
    const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service,executions:{} as ReturnType<typeof createExecutionService>,migration}});apps.push(app);
    const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
    expect((await app.inject({method:'GET',url:'/v1/automations/migrations/legacy',headers:{authorization}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/v1/automations/migrations/legacy',headers:{authorization},payload:{limit:50}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/v1/automations/migrations/legacy',headers:{authorization,'idempotency-key':'migrate-owner'},payload:{limit:50}})).statusCode).toBe(200);
    expect(migration.migrateBatch).toHaveBeenLastCalledWith(org,{limit:50,actorId:user});
    role='ADMIN';
    expect((await app.inject({method:'POST',url:`/v1/automations/migrations/legacy/${id}/cutover`,headers:{authorization,'idempotency-key':'cutover-admin'},payload:{}})).statusCode).toBe(200);
    expect(migration.cutover).toHaveBeenLastCalledWith(org,id,user);
    role='VIEWER';
    expect((await app.inject({method:'POST',url:`/v1/automations/migrations/legacy/${id}/rollback`,headers:{authorization,'idempotency-key':'rollback-viewer'},payload:{}})).statusCode).toBe(403);
    expect(migration.rollback).not.toHaveBeenCalled();
  });
});
