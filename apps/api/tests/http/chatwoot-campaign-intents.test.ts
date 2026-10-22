import {afterEach,it,expect,vi} from 'vitest';
import {issueAccessToken} from '@jrc/security';
import {buildApp} from '../../src/app.js';
import type {ChatwootControlAuth} from '../../src/modules/integrations/chatwoot-control-auth.js';
import type {ChatwootControlService} from '../../src/modules/integrations/chatwoot-control-service.js';
const org='701c3ae6-5b19-4257-ae4f-5528b61b7fa6',id='ca93ad35-0a3f-48dc-9032-c47780498804',secret='synthetic-campaign-http-secret-32-bytes';
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
function fixture(){
 const authorize=vi.fn().mockResolvedValue({organizationId:org}),reserveCampaignIntent=vi.fn().mockResolvedValue({protocol:'chatwoot-campaigns/v1',intentId:id,state:'RESERVED',expiresAt:'2026-10-23T15:00:00.000Z',replayed:false});
 const campaignTransport=vi.fn().mockResolvedValue({protocol:'chatwoot-campaigns/v1',integrationId:id,inboxId:9,instanceId:id,destinationRevision:1,identityRevision:1,ownerRevision:0,ready:true,reason:null,numberSuffix:'0100'});
 const campaignReceipt=vi.fn().mockResolvedValue({protocol:'chatwoot-campaigns/v1',integrationId:id,conversationId:21,messageId:25,status:'queued',errorCode:null});
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({verifyPasswordOrDummy:async()=>false}),chatwootControl:{jwtSecret:secret,
  authenticateApiKey:async raw=>({apiKeyId:id,organizationId:org,scopes:raw==='control-manage'?['chatwoot:manage','chatwoot:read']:['messaging:send']}),
  service:{enabled:true,authorize} as unknown as ChatwootControlAuth,facade:{reserveCampaignIntent,campaignTransport,campaignReceipt} as unknown as ChatwootControlService}});
 apps.push(app);
 return {app,authorize,reserveCampaignIntent,campaignTransport,campaignReceipt,url:`/v1/integrations/chatwoot/control/connections/${id}`,
  headers:{'x-jrc-api-key':'control-manage','idempotency-key':'campaign-delivery-12','x-jrc-external-actor':'17'},
  payload:{conversationId:21,messageId:25,campaignId:'campaign:12',kind:'text',text:'Synthetic campaign',destinationRevision:1,identityRevision:1,ownerRevision:0}};
}
it('reads canonical transport and receipt with the dedicated read authorization',async()=>{
 const h=fixture();expect((await h.app.inject({method:'GET',url:`${h.url}/campaign-transport`,headers:h.headers})).statusCode).toBe(200);
 expect((await h.app.inject({method:'GET',url:`${h.url}/conversations/21/campaign-messages/25`,headers:h.headers})).json()).toMatchObject({status:'queued'});
 expect(h.authorize).toHaveBeenLastCalledWith(expect.anything(),'chatwoot:read',id);
});
it('reserves with exact actor attribution, idempotency and strict message binding',async()=>{
 const h=fixture();const r=await h.app.inject({method:'POST',url:`${h.url}/campaign-intents`,headers:h.headers,payload:h.payload});
 expect(r.statusCode).toBe(201);expect(r.headers['cache-control']).toBe('no-store');expect(r.json()).toMatchObject({intentId:id,replayed:false});
 expect(h.authorize).toHaveBeenLastCalledWith(expect.objectContaining({kind:'API_KEY'}),'chatwoot:manage',id,'17');
 expect(h.reserveCampaignIntent).toHaveBeenCalledWith(expect.anything(),id,h.payload,'campaign-delivery-12');
});
it.each(['missing-idempotency','missing-actor','invalid-actor','extra-tenant'] as const)('rejects %s without reservation',async bad=>{
 const h=fixture(),headers:Record<string,string>={...h.headers};if(bad==='missing-idempotency')delete headers['idempotency-key'];if(bad==='missing-actor')delete headers['x-jrc-external-actor'];if(bad==='invalid-actor')headers['x-jrc-external-actor']='someone';
 const r=await h.app.inject({method:'POST',url:`${h.url}/campaign-intents`,headers,payload:bad==='extra-tenant'?{...h.payload,organizationId:org}:h.payload});
 expect(r.statusCode).toBe(400);expect(h.reserveCampaignIntent).not.toHaveBeenCalled();
});
it('rejects generic partner send keys and administrator JWTs on campaign admission',async()=>{
 const h=fixture();expect((await h.app.inject({method:'POST',url:`${h.url}/campaign-intents`,headers:{...h.headers,'x-jrc-api-key':'generic-partner'},payload:h.payload})).statusCode).toBe(403);
 const token=await issueAccessToken({userId:id,organizationId:org,role:'OWNER'},secret);
 expect((await h.app.inject({method:'POST',url:`${h.url}/campaign-intents`,headers:{authorization:`Bearer ${token}`,'idempotency-key':'campaign-delivery-12','x-jrc-external-actor':'17'},payload:h.payload})).statusCode).toBe(403);
 expect(h.reserveCampaignIntent).not.toHaveBeenCalled();
});
it('returns a client error for an empty JSON body without reserving an intent',async()=>{
 const h=fixture();const r=await h.app.inject({method:'POST',url:`${h.url}/campaign-intents`,headers:{...h.headers,'content-type':'application/json'},payload:''});
 expect(r.statusCode).toBe(400);expect(h.reserveCampaignIntent).not.toHaveBeenCalled();
});
