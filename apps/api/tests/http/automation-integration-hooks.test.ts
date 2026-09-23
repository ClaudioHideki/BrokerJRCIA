import {expect,it,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {buildApp} from '../../src/app.js';
import type {AutomationImporter} from '../../src/modules/automation-integrations/importer.js';
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
  expect(response.statusCode).toBe(url.endsWith('imports')?201:200);expect(response.headers['cache-control']).toBe('no-store');if(url.endsWith('imports'))expect(serviceImport).toHaveBeenCalledWith(org,{source:'AUTO',content:'{}'});else expect(list).toHaveBeenCalledWith(org);
 }finally{clearTimeout(timer);await app.close();}
});
