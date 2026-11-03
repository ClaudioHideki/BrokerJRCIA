import {expect,it,vi} from 'vitest';
import {createEventRouter} from '../../src/modules/automations/service.js';
import type {AutomationRepository} from '../../src/modules/automations/repository.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',conversation='33333333-3333-4333-8333-333333333333',messageId='44444444-4444-4444-8444-444444444444',mediaId='55555555-5555-4555-8555-555555555555';
const media={source:'CANONICAL_MESSAGE',messageId,mediaId,kind:'image',fileName:'canonical.png'};
function fixture(found=true){
 const query=vi.fn(async(_sql:string,_args:unknown[])=>({rows:found?[{messageId,mediaId,kind:'image',fileName:'canonical.png'}]:[],rowCount:found?1:0}));
 const insertEvent=vi.fn(async(_tx:unknown,_row:Record<string,unknown>)=>true),routeEvent=vi.fn(async(_tx:unknown,_row:Record<string,unknown>)=>null);
 const repository={insertEvent,routeEvent} as unknown as AutomationRepository;
 const router=createEventRouter({enabled:true,repository,transact:(_org,work)=>work({query} as unknown as TenantTransaction)});
 return{query,insertEvent,routeEvent,router};
}
it('rebuilds a media reference from the exact tenant/channel/conversation/message row instead of caller metadata',async()=>{
 const t=fixture();await t.router.route(org,{channelId:channel,conversationId:conversation,eventKey:'media',text:'ignored caption',mediaMessageId:messageId,payload:{inputMedia:{source:'SIMULATION_FIXTURE'},messageId:mediaId,text:'forged'}});
 expect(t.query).toHaveBeenCalledWith(expect.stringContaining('messaging_media'),[org,channel,conversation,messageId]);
 expect(t.insertEvent.mock.calls[0]?.[1]).toMatchObject({payload:{text:'',inputMedia:media,messageId}});
 expect(t.routeEvent.mock.calls[0]?.[1]).toMatchObject({input:{text:'',inputMedia:media,messageId}});
});
it('rejects missing or out-of-scope canonical media before admitting an event',async()=>{
 const t=fixture(false);await expect(t.router.route(org,{channelId:channel,conversationId:conversation,eventKey:'foreign',text:'',mediaMessageId:messageId}))
  .rejects.toMatchObject({code:'AUTOMATION_INPUT_MEDIA_NOT_FOUND',statusCode:404});
 expect(t.insertEvent).not.toHaveBeenCalled();
});
it('removes a forged private media envelope and persists the canonical text in both event and execution input',async()=>{
 const t=fixture();await t.router.route(org,{channelId:channel,conversationId:conversation,eventKey:'text',text:'actual text',payload:{messageId,inputMedia:media,text:'forged text'}});
 expect(t.query).not.toHaveBeenCalled();
 for(const args of [t.insertEvent.mock.calls[0]?.[1]?.payload,t.routeEvent.mock.calls[0]?.[1]?.input]){
  expect(args).toMatchObject({text:'actual text',messageId});expect(args).not.toHaveProperty('inputMedia');
 }
});
it('does not interpret a caller-provided central reference or caption as a typed attachment',async()=>{
 const t=fixture();await t.router.route(org,{channelId:channel,conversationId:conversation,eventKey:'text',text:'actual text',payload:{centralMediaReferenceId:mediaId,inputMedia:{source:'CENTRAL_ATTACHMENT_REFERENCE',referenceId:mediaId}}});
 expect(t.query).not.toHaveBeenCalled();expect(t.routeEvent.mock.calls[0]?.[1]?.input).not.toHaveProperty('centralMediaReferenceId');
});
