import {afterEach,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../../../apps/api/src/app.ts';
const IMAGE='sha256:b375544ab454a24fb8a305ba6f476c9b09b8aa0d99bed645c184d41510552fbb';
const SOURCE_SHA='50d088aaae54eb58ed23b97fd721c48316d4f635c1ebf4e84063d5af72e5cd40';
const source=process.env.TEST_LAB2_RESPONSE_RB;
if(!source)throw Error('TEST_LAB2_RESPONSE_RB_REQUIRED: explicit authorized local JRC Conversas response.rb');
const consumer=realpathSync(source),probe=fileURLToPath(new URL('./response-probe.rb',import.meta.url));
if(createHash('sha256').update(readFileSync(consumer)).digest('hex')!==SOURCE_SHA)throw Error('LAB2_CONSUMER_SOURCE_CHANGED_REVIEW_REQUIRED');
function consume(inputs){
 const result=spawnSync('docker',['run','--rm','--interactive','--network','none','--memory','192m','--cpus','0.5','--pids-limit','64','--read-only',
 '--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,source=${consumer},target=/consumer/response.rb,readonly`,
 '--mount',`type=bind,source=${probe},target=/probe.rb,readonly`,'--entrypoint','ruby',IMAGE,'/probe.rb'],
 {input:JSON.stringify(inputs),encoding:'utf8',timeout:20000,windowsHide:true,maxBuffer:3_000_000});
 if(result.error||result.status!==0)throw Error('LAB2_RUBY_PROBE_FAILED: '+(result.error?.message??result.stderr));
 return JSON.parse(result.stdout);
}
const org='00000000-0000-4000-8000-000000000901',integrationId='00000000-0000-4000-8000-000000000902',instanceId='00000000-0000-4000-8000-000000000903',operationId='00000000-0000-4000-8000-000000000904';
const binding={integrationId,inboxId:7,instanceId},now=new Date().toISOString();
const instance={id:instanceId,organizationId:org,providerAccountId:'00000000-0000-4000-8000-000000000905',name:'Synthetic host contract',provider:'BAILEYS',status:'CONNECTING',createdAt:now,updatedAt:now};
const apps=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();});
function harness(){
 const calls=[];
 const progress={operationId,state:'UNKNOWN',instanceStatus:'CONNECTING',reconciliationRequired:true,lastError:'PROVIDER_TIMEOUT',updatedAt:now,action:null};
 const health={...binding,integrationStatus:'READY',instanceStatus:'CONNECTED',transportStatus:'UNVERIFIED',checkedAt:now,lastError:null,
 callbackVerifiedAt:null,lastSuccessfulInboundAt:null,lastSuccessfulOutboundAt:null,identityStatus:'UNVERIFIED',identityApproved:false,identityRevision:1,observedNumberSuffix:null,allowedActions:['status']};
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),
 chatwootControl:{jwtSecret:'synthetic-lab2-jwt-secret-minimum-length',authenticateApiKey:async key=>key==='synthetic-lab2-control'?{organizationId:org,apiKeyId:operationId,scopes:['chatwoot:read','chatwoot:pair']}:null,
 service:{enabled:true,authorize:async(auth,scope,id,actor)=>{calls.push({scope,id,actor});return {organizationId:auth.organizationId,accountId:3,destinationRevision:1};}},
 facade:{status:async()=>health,pair:async(_p,id,key)=>{calls.push({command:'pair',id,key});return {instance,operationId,pending:true,replayed:false,reconciliationRequired:false,action:{type:'NONE',reason:'CONNECTION_PENDING'}};},
 pairOperation:async(_p,id,operation)=>{calls.push({command:'read',id,operation});return progress;}}}});
 apps.push(app);return {app,calls,health,progress,headers:{'x-jrc-api-key':'synthetic-lab2-control','x-jrc-external-actor':'42'}};
}
const prefix='/v1/integrations/chatwoot/control/connections/'+integrationId;
it('actual Broker status response remains consumable by actual JRC Conversas binding projection without upgrading transport evidence',async()=>{
 const h=harness(),response=await h.app.inject({method:'GET',url:prefix+'/status',headers:h.headers});
 expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
 const [accepted,foreign]=consume([{method:'health',value:response.json(),binding},{method:'health',value:response.json(),binding:{...binding,inboxId:8}}]);
 expect(accepted).toEqual({ok:true,value:h.health});expect(accepted.value.transportStatus).toBe('UNVERIFIED');
 expect(foreign).toEqual({ok:false,code:'JRC_BROKER_INVALID_RESPONSE'});
});
it('actual pending pair then UNKNOWN progress reaches the host consumer with same operation and without another pair command',async()=>{
 const h=harness(),response=await h.app.inject({method:'POST',url:prefix+'/pair',headers:{...h.headers,'idempotency-key':'synthetic-lab2-intent'},payload:{}});
 expect(response.statusCode).toBe(202);
 const read=await h.app.inject({method:'GET',url:prefix+'/pair-operations/'+operationId,headers:h.headers});expect(read.statusCode).toBe(200);
 const [pending,unknown]=consume([{method:'mutation',value:response.json(),binding},{method:'pair_operation',value:read.json(),operationId}]);
 expect(pending.value).toMatchObject({operationId,pending:true,action:{type:'NONE',reason:'CONNECTION_PENDING'}});
 expect(unknown).toEqual({ok:true,value:{operationId,state:'UNKNOWN',reconciliationRequired:true}});
 expect(h.calls.filter(x=>x.command==='pair')).toEqual([{command:'pair',id:integrationId,key:'synthetic-lab2-intent'}]);
 expect(h.calls).toContainEqual({scope:'chatwoot:pair',id:integrationId,actor:'42'});
});
it('actual host consumer accepts a current one-time challenge and rejects expiry or wrong durable operation while filtering diagnostics',async()=>{
 const h=harness();h.progress.state='SUCCEEDED';h.progress.reconciliationRequired=false;h.progress.lastError=null;
 h.progress.action={type:'PAIRING_CODE',code:'SYNTHETIC',expiresAt:new Date(Date.now()+60000).toISOString()};
 const response=await h.app.inject({method:'GET',url:prefix+'/pair-operations/'+operationId,headers:h.headers});expect(response.statusCode).toBe(200);
 const value=response.json();
 const [current,expired,foreign]=consume([
 {method:'pair_operation',value:{...value,lastError:'synthetic-provider-diagnostic'},operationId},
 {method:'pair_operation',value:{...value,action:{...value.action,expiresAt:'2000-01-01T00:00:00.000Z'}},operationId},
 {method:'pair_operation',value,operationId:instanceId}]);
 expect(current).toEqual({ok:true,value:{operationId,state:'SUCCEEDED',reconciliationRequired:false,action:value.action}});
 expect(JSON.stringify(current)).not.toContain('synthetic-provider-diagnostic');
 expect(expired).toEqual({ok:false,code:'JRC_BROKER_INVALID_RESPONSE'});expect(foreign).toEqual({ok:false,code:'JRC_BROKER_INVALID_RESPONSE'});
});

it('actual Broker QR operation response passes the host PNG consumer but malformed bytes never become a host challenge',async()=>{
 const h=harness();h.progress.state='SUCCEEDED';h.progress.reconciliationRequired=false;h.progress.lastError=null;
 // Synthetic signature fixture only; this does not assert PNG decoding or a scannable WhatsApp QR.
 h.progress.action={type:'QR_CODE',encoding:'BASE64',value:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64'),expiresAt:new Date(Date.now()+60000).toISOString()};
 const response=await h.app.inject({method:'GET',url:prefix+'/pair-operations/'+operationId,headers:h.headers});expect(response.statusCode).toBe(200);
 const value=response.json(),[valid,invalid]=consume([{method:'pair_operation',value,operationId},
 {method:'pair_operation',value:{...value,action:{...value.action,value:Buffer.from('synthetic-invalid-png').toString('base64')}},operationId}]);
 expect(valid).toEqual({ok:true,value:{operationId,state:'SUCCEEDED',reconciliationRequired:false,action:value.action}});
 expect(invalid).toEqual({ok:false,code:'JRC_BROKER_INVALID_RESPONSE'});
});
