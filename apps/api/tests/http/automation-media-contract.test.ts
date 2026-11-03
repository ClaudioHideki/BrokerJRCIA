import {afterEach,expect,it,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {validateAutomationGraph} from '@jrc/contracts';
import {buildApp} from '../../src/app.js';
import {createOpenApiDocument} from '../../src/http/openapi.js';
import type {AutomationService,createExecutionService} from '../../src/modules/automations/service.js';
const secret='automation-media-secret-at-least-32-bytes',org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const apps:Array<ReturnType<typeof buildApp>>=[];afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
it('validates V3 graph capture and explicit fixture MEDIA through real HTTP schemas',async()=>{
 const create=vi.fn(async()=>({id})),simulate=vi.fn(async()=>({status:'WAITING'}));
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automations:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=>'OWNER',service:{create,simulate} as unknown as AutomationService,executions:{} as ReturnType<typeof createExecutionService>}});apps.push(app);
 const authorization=`Bearer ${await issueAccessToken({userId:id,organizationId:org,role:'OWNER'},secret)}`;
 const node=(nodeId:string,type:string,data:Record<string,unknown>={})=>({id:nodeId,type,label:nodeId,position:{x:0,y:0},data});
 const graph=(version=3,inputType='image')=>({nodes:[node('start','start'),node('capture','input',{inputConfigVersion:version,inputType,variable:'attachment',maxAttempts:2}),node('end','end')],edges:[{id:'a',source:'start',target:'capture',port:'next'},{id:'b',source:'capture',target:'end',port:'next'},{id:'c',source:'capture',target:'end',port:'exhausted'}]});
 for(const [index,payload] of [{name:'Image',graph:graph()},{name:'File',graph:graph(3,'file')}].entries())expect((await app.inject({method:'POST',url:'/v1/automations',headers:{authorization,'idempotency-key':`media-${index}`},payload})).statusCode).toBe(201);
 // Incomplete drafts remain editable; compile/publish validation owns node configuration.
 for(const payload of [{name:'Wrong old marker',graph:graph(2)},{name:'Not a structured location',graph:graph(3,'location')}]){
  expect((await app.inject({method:'POST',url:'/v1/automations',headers:{authorization,'idempotency-key':'invalid'},payload})).statusCode).toBe(201);
  expect(validateAutomationGraph(payload.graph)).toContainEqual(expect.objectContaining({nodeId:'capture',code:'INVALID_CONFIG'}));
 }
 const fixture={type:'MEDIA',kind:'image',fileName:'fixture.png'};
 expect((await app.inject({method:'POST',url:`/v1/automations/${id}/simulate`,headers:{authorization},payload:{text:'Oi',events:[fixture]}})).statusCode).toBe(200);
 expect(simulate).toHaveBeenCalledWith(org,id,{text:'Oi',events:[fixture]});
 for(const patch of [{url:'https://untrusted.invalid/file'},{mediaId:id},{source:'CANONICAL_MESSAGE'}])expect((await app.inject({method:'POST',url:`/v1/automations/${id}/simulate`,headers:{authorization},payload:{text:'Oi',events:[{...fixture,...patch}]}})).statusCode).toBe(400);
});
it('documents fixture MEDIA as a closed simulation variant in public and delegated OpenAPI',async()=>{
 const document=await createOpenApiDocument() as {paths:Record<string,{post?:{requestBody?:unknown}}>};
 for(const path of ['/v1/automations/{id}/simulate','/v1/delegated-flows/{id}/simulate','/v1/executions/{id}/simulate']){
  const body=JSON.stringify(document.paths[path]?.post?.requestBody);expect(body).toContain('MEDIA');expect(body).toContain('fileName');expect(body).toContain('additionalProperties":false');
 }
});
