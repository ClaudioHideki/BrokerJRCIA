import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {buildApp} from '../../src/app.js';
const apps:ReturnType<typeof buildApp>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
function fixture(){
  const sourceEventId=randomUUID(),channel=randomUUID(),body=JSON.stringify({event:'messages.upsert',instance:'synthetic',data:{}});
  const ingest=vi.fn().mockResolvedValue({status:'accepted',sourceEventId,durablyAccepted:true});
  const app=buildApp({nodeEnv:'test',passwordVerifierInitializer:async()=>({async verifyPasswordOrDummy(){return false;}}),
    integrations:{jwtSecret:'synthetic-test-signing-key-'.repeat(2),authenticateApiKey:async()=>null,resolveCurrentRole:async()=>null,qr:{ingest} as never}});
  apps.push(app);
  return{app,ingest,body,sourceEventId,url:`/v1/webhooks/whatsapp/${channel}`,headers:{'content-type':'application/json',authorization:'Bearer synthetic',
    'x-jrc-origin-event-id':sourceEventId,'x-jrc-origin-content-sha256':createHash('sha256').update(body).digest('hex')}};
}
it('returns the service durable receipt, not a plain HTTP acceptance',async()=>{
  const h=fixture();const r=await h.app.inject({method:'POST',url:h.url,payload:h.body,headers:h.headers});
  expect(r.json()).toEqual({status:'accepted',sourceEventId:h.sourceEventId,durablyAccepted:true});
});
it('refuses a wrong raw-byte digest before dispatching the event',async()=>{
  const h=fixture();const r=await h.app.inject({method:'POST',url:h.url,payload:h.body+' ',headers:h.headers});
  expect(r.statusCode).toBe(400);expect(h.ingest).not.toHaveBeenCalled();
});
