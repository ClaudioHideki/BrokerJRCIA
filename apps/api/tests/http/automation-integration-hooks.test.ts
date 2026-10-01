import {expect,it,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {welcomeFlow} from '@jrc/contracts';
import {buildApp} from '../../src/app.js';
import {createAutomationImporter,type AutomationImporter} from '../../src/modules/automation-integrations/importer.js';
import type {CredentialService} from '../../src/modules/automation-integrations/credentials.js';
import type {createWebhookService} from '../../src/modules/automation-integrations/webhooks.js';

it.each(['/v1/automation-imports','/v1/credentials','/v1/webhooks'])('completes no-store HTTP requests without hanging in onRequest: %s',async url=>{
 const org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',secret='qa-route-hook-test-32-characters-secret';
 const auth={jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=> 'OWNER' as const};
 const serviceImport=vi.fn(async()=>({createdAsDraft:true})),list=vi.fn(async()=>({data:[]}));
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),
  automationImports:{...auth,service:{import:serviceImport} as unknown as AutomationImporter},credentials:{...auth,service:{list} as unknown as CredentialService},automationWebhooks:{...auth,service:{list} as unknown as ReturnType<typeof createWebhookService>}});
 const authorization='Bearer '+await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret);let timer:ReturnType<typeof setTimeout>|undefined;
 try{const response=await Promise.race([app.inject({method:url.endsWith('imports')?'POST':'GET',url,headers:{authorization,'idempotency-key':'qa-import-hook'},...(url.endsWith('imports')?{payload:{source:'AUTO',content:'{}'}}:{})}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('HTTP_HOOK_DID_NOT_COMPLETE')),2500);})]);
  expect(response.statusCode).toBe(url.endsWith('imports')?201:200);expect(response.headers['cache-control']).toBe('no-store');if(url.endsWith('imports'))expect(serviceImport).toHaveBeenCalledWith(org,{source:'AUTO',content:'{}'},'qa-import-hook');else expect(list).toHaveBeenCalledWith(org);
 }finally{clearTimeout(timer);await app.close();}
});

it('rejects draft imports when the company module is disabled before storing the source artifact',async()=>{
 const org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',secret='qa-route-hook-test-32-characters-secret';
 const query=vi.fn(async(statement:string,params:readonly unknown[]=[])=>{
  expect(params).toEqual([org]);
  const sql=statement.replace(/\s+/g,' ').trim();
  if(/^SELECT tenant_is_active\(\$1::uuid\) AS active$/i.test(sql))return {rows:[{active:true}]};
  if(/^select o.status,coalesce\(f.enabled,false\) as "moduleEnabled" from organizations o left join flow_features f on f.organization_id=o.id where o.id=\$1$/i.test(sql))
   return {rows:[{status:'ACTIVE',moduleEnabled:false}]};
  throw new Error('Disabled import attempted an unexpected query: '+sql);
 });
 const transact=vi.fn(async(_org:string,work:(tx:never)=>Promise<unknown>)=>work({query} as never));
 const importer=createAutomationImporter({transact,keyring:JSON.stringify({1:Buffer.alloc(32,8).toString('base64')}),enabled:false});
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automationImports:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=> 'OWNER' as const,service:importer}});
 const authorization='Bearer '+await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret);
 try{const response=await app.inject({method:'POST',url:'/v1/automation-imports',headers:{authorization,'idempotency-key':'disabled-import'},payload:{source:'AUTO',content:'{}'}});
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({code:'AUTOMATION_MODULE_DISABLED',requestId:expect.any(String)});
  const statements=query.mock.calls.map(([sql])=>sql.replace(/\s+/g,' ').trim());
  expect(statements).toHaveLength(2);
  expect(statements[0]).toMatch(/^SELECT tenant_is_active\(\$1::uuid\) AS active$/i);
  expect(statements[1]).toMatch(/^select o.status,coalesce\(f.enabled,false\)/i);
  expect(statements.every(sql=>/^select /i.test(sql))).toBe(true);
  expect(statements.some(sql=>/automation_import_artifacts|idempotency_records/i.test(sql))).toBe(false);
 }finally{await app.close();}
});

it('previews an automation without persisting its source artifact',async()=>{
 const org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222',secret='qa-route-hook-test-32-characters-secret';
 const transact=vi.fn(async()=>{throw new Error('PREVIEW_SHOULD_NOT_TOUCH_STORAGE');});
 const importer=createAutomationImporter({transact,keyring:JSON.stringify({1:Buffer.alloc(32,8).toString('base64')}),enabled:false});
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),automationImports:{jwtSecret:secret,authenticateApiKey:async()=>null,resolveCurrentRole:async()=> 'OWNER' as const,service:importer}});
 const authorization='Bearer '+await issueAccessToken({userId:user,organizationId:org,role:'OWNER'},secret);
 const content=JSON.stringify({format:'jrc-flows/1',flow:{name:'Prévia',graph:welcomeFlow()}});
 try{const response=await app.inject({method:'POST',url:'/v1/automation-imports/preview',headers:{authorization},payload:{source:'AUTO',content}});
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({name:'Prévia',source:'JRC',createdAsDraft:false,report:{summary:{autoPublished:false}}});
  expect(response.json().report.warnings).toContain('Prévia sem gravação. Confirme a importação para salvar o rascunho.');
  expect(response.json()).not.toHaveProperty('id');
  expect(transact).not.toHaveBeenCalled();
 }finally{await app.close();}
});
