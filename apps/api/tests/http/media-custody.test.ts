import {expect,it,vi} from 'vitest';
import {buildApp} from '../../src/app.js';
import {issueAccessToken} from '@jrc/security';
const org='00000000-0000-4000-8000-000000000001',secret='a'.repeat(40);
const input={schemaVersion:1,channelId:org,messageId:org,mediaId:org,endpointId:org,destinationVersion:1,clientReceiptId:org,byteSize:123,sha256:'a'.repeat(64),storageObjectId:'synthetic/asset',attestation:'DURABLY_STORED'};
async function harness(scopes=['media:archive']){
 const receipt={id:org,organizationId:org,...input,acceptedAt:'2026-10-29T00:00:00.000Z'};
 const service={record:vi.fn(async()=>({schemaVersion:1,receipt,replayed:false})),get:vi.fn(async()=>({schemaVersion:1,receipt})),evaluate:vi.fn(async()=>({schemaVersion:1,receiptId:org,policy:'KEEP',eligibleForDeletion:false,reason:'KEEP_POLICY',physicalStorageVerified:false}))};
 const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({} as never),mediaCustody:{jwtSecret:secret,authenticateApiKey:async raw=>raw==='valid'?{organizationId:org,apiKeyId:org,scopes}:null,service:service as never}});
 await app.ready();return {app,service};
}
const headers={'x-jrc-api-key':'valid','idempotency-key':org};
it('wires versioned receipt POST and query/evaluation into the Broker with tenant from principal',async()=>{
 const h=await harness();try{
  const response=await h.app.inject({method:'POST',url:'/v1/media-custody/receipts',headers,payload:input});
  expect(response.statusCode).toBe(201);expect(response.json().receipt.id).toBe(org);expect(response.headers['cache-control']).toBe('no-store');
  expect(h.service.record).toHaveBeenCalledWith(org,org,input,org);
  expect((await h.app.inject({method:'GET',url:`/v1/media-custody/receipts/${org}`,headers})).statusCode).toBe(200);
  expect((await h.app.inject({method:'GET',url:`/v1/media-custody/receipts/${org}/retention`,headers})).json()).toMatchObject({policy:'KEEP',eligibleForDeletion:false});
 }finally{await h.app.close();}
});
it.each([['media:upload','media:send','messaging:read'],['chatwoot:manage'],['chatwoot:manage','media:archive']].map(scopes=>({scopes})))('requires explicit generic archive authority and refuses control scopes $scopes',async({scopes})=>{
 const h=await harness(scopes);try{expect((await h.app.inject({method:'POST',url:'/v1/media-custody/receipts',headers,payload:input})).statusCode).toBe(403);expect(h.service.record).not.toHaveBeenCalled();}finally{await h.app.close();}
});
it('rejects JWT, tenant injection and invalid protocol data before persistence',async()=>{
 const h=await harness();try{
  const token=await issueAccessToken({userId:org,organizationId:org,role:'OWNER'},secret);
  expect((await h.app.inject({method:'POST',url:'/v1/media-custody/receipts',headers:{authorization:`Bearer ${token}`,'idempotency-key':org},payload:input})).statusCode).toBe(403);
  for(const change of [{organizationId:org},{schemaVersion:2},{byteSize:0},{sha256:'partial'},{destinationVersion:2},{storageObjectId:'https://unregistered.example.test/attachment'}])expect((await h.app.inject({method:'POST',url:'/v1/media-custody/receipts',headers,payload:{...input,...change}})).statusCode).toBe(400);
  expect(h.service.record).not.toHaveBeenCalled();
 }finally{await h.app.close();}
});
