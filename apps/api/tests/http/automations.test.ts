import { afterEach,describe,expect,it,vi } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';
import type { LegacyFlowMigrationService } from '../../src/modules/automations/legacy-migration.js';
import { AutomationError, type AutomationService, type createExecutionService } from '../../src/modules/automations/service.js';

const secret='automation-routes-secret-with-at-least-32-bytes',org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const graph={nodes:[{id:'start',type:'start',label:'Início',position:{x:0,y:0},data:{}},{id:'end',type:'end',label:'Fim',position:{x:1,y:1},data:{}}],edges:[{id:'e',source:'start',target:'end',port:'next'}]};
describe('automation v2 routes',()=>{const apps:Array<ReturnType<typeof buildApp>>=[];afterEach(async()=>Promise.all(apps.splice(0).map(app=>app.close())));
  it('validates execution search and binds filters and replay to the current tenant and current role',async()=>{
    let role:'OWNER'|'VIEWER'='OWNER';
    const executions={list:vi.fn().mockResolvedValue({data:[],nextCursor:null}),playground:vi.fn().mockResolvedValue({executionId:id,version:1}),simulateHistorical:vi.fn().mockResolvedValue({status:'COMPLETED'})} as unknown as ReturnType<typeof createExecutionService>;
    const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service:{} as AutomationService,executions}});apps.push(app);
    const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
    const response=await app.inject({method:'GET',url:`/v1/executions?status=FAILED&channelId=${id}&pageSize=25&from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z`,headers:{authorization}});
    expect(response.statusCode).toBe(200);expect(executions.list).toHaveBeenCalledWith(org,undefined,{status:'FAILED',channelId:id,pageSize:25,from:'2030-01-01T00:00:00Z',to:'2030-01-02T00:00:00Z'});
    expect((await app.inject({method:'GET',url:'/v1/executions',headers:{authorization}})).statusCode).toBe(200);
    expect(executions.list).toHaveBeenLastCalledWith(org,undefined);
    expect((await app.inject({method:'GET',url:'/v1/executions?automationId='+id,headers:{authorization}})).statusCode).toBe(200);
    expect(executions.list).toHaveBeenLastCalledWith(org,id);
    for(const query of ['pageSize=101','status=DELIVERED','organizationId='+id,'search=not-a-uuid'])expect((await app.inject({method:'GET',url:'/v1/executions?'+query,headers:{authorization}})).statusCode).toBe(400);
    expect((await app.inject({method:'GET',url:`/v1/executions/${id}/playground`,headers:{authorization}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/v1/executions/${id}/simulate`,headers:{authorization},payload:{text:'cenário'}})).statusCode).toBe(200);
    expect(executions.simulateHistorical).toHaveBeenCalledWith(org,id,{text:'cenário'});
    role='VIEWER';
    expect((await app.inject({method:'GET',url:`/v1/executions/${id}/playground`,headers:{authorization}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:`/v1/executions/${id}/simulate`,headers:{authorization},payload:{text:'cenário'}})).statusCode).toBe(403);
  });
  it('accepts bounded virtual events and rejects ambiguous timelines, invalid clocks and revoked roles',async()=>{
    let role:'OWNER'|'VIEWER'='OWNER';
    const service={simulate:async(_org:string,_id:string,input:unknown)=>({simulationInput:input})} as unknown as AutomationService;
    const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service,executions:{} as ReturnType<typeof createExecutionService>}});apps.push(app);
    const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
    const inject=(payload:unknown)=>app.inject({method:'POST',url:`/v1/automations/${id}/simulate`,headers:{authorization},payload:payload as Record<string,unknown>});
    const payload={text:'oi',clock:'2030-01-01T00:00:00.000Z',events:[{type:'ELAPSE',seconds:5},{type:'MESSAGE',text:'Resposta'}]};
    const valid=await inject(payload);expect(valid.statusCode).toBe(200);expect(valid.json().simulationInput).toEqual(payload);
    expect((await inject({...payload,events:Array.from({length:100},()=>({type:'MESSAGE',text:'inválido'}))})).statusCode).toBe(200);
    for(const invalid of [{...payload,replies:['extra']},{...payload,events:[{type:'ELAPSE',seconds:0}]},{...payload,events:Array.from({length:201},()=>({type:'ELAPSE',seconds:1}))},{...payload,clock:'2030-02-30T00:00:00.000Z'},{...payload,events:[{type:'RESUME',output:'forjado'}]}])expect((await inject(invalid)).statusCode).toBe(400);
    role='VIEWER';expect((await inject(payload)).statusCode).toBe(403);
  });
  it('returns structured diagnostics and creation availability without losing the string adapter', async()=>{
    const diagnostics=[{nodeId:'message-2',field:'data.text',code:'INVALID_CONFIG',message:'Mesmo nome: informe uma mensagem.'}];
    const service={publish:vi.fn().mockRejectedValue(new AutomationError('AUTOMATION_INVALID',422,diagnostics)),validate:vi.fn().mockResolvedValue({valid:false,diagnostics,errors:diagnostics.map(item=>item.message)})} as unknown as AutomationService;
    const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=> 'OWNER',service,executions:{} as ReturnType<typeof createExecutionService>}});apps.push(app);
    const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
    const response=await app.inject({method:'POST',url:`/v1/automations/${id}/publish`,headers:{authorization,'idempotency-key':'publish'},payload:{revision:1}});
    expect(response.statusCode).toBe(422);expect(response.json()).toMatchObject({diagnostics,details:diagnostics,legacyErrors:[diagnostics[0]!.message]});
    const catalog=(await app.inject({method:'GET',url:'/v1/automation-nodes',headers:{authorization}})).json().data;
    expect(catalog.find((node:{type:string})=>node.type==='sql')).toMatchObject({availability:'UNAVAILABLE',unavailableReason:expect.any(String)});
    expect(catalog.find((node:{type:string})=>node.type==='message')).toMatchObject({availability:'AVAILABLE'});
  });
  it('exposes canonical CRUD and revalidates write roles',async()=>{let role:'OWNER'|'VIEWER'='OWNER';const automation={id,organizationId:org,name:'Atendimento',lifecycleStatus:'DRAFT',draft:{revision:1,graph},activeVersion:null,updatedAt:'2030-01-01T00:00:00.000Z'};
    const service={status:vi.fn().mockReturnValue({enabled:true,engine:'AUTOMATION_RUNTIME_V2'}),list:vi.fn().mockResolvedValue({data:[automation]}),create:vi.fn().mockResolvedValue(automation)} as unknown as AutomationService;
    const executions={} as ReturnType<typeof createExecutionService>,app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>role,service,executions}});apps.push(app);
    const authorization=`Bearer ${await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret)}`;
    expect((await app.inject({method:'GET',url:'/v1/automations',headers:{authorization}})).json().data[0].id).toBe(id);
    const page=await app.inject({method:'GET',url:'/v1/automations?pageSize=25&cursor=cursor-1',headers:{authorization}});
    expect(page.statusCode).toBe(200);
    expect(service.list).toHaveBeenLastCalledWith(org,{pageSize:25,cursor:'cursor-1'});
    expect((await app.inject({method:'GET',url:'/v1/automations?pageSize=201',headers:{authorization}})).statusCode).toBe(400);
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
