import {expect,it,vi} from 'vitest';
import * as media from '../../src/modules/messaging/media-store.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222',integrationId='33333333-3333-4333-8333-333333333333';
const descriptor={integrationId,conversationId:51,messageId:991,attachmentId:801,groupReply:true,destinationRevision:2,credentialRevision:3};
it('registers a group attachment snapshot by IDs and revisions without accepting arbitrary URLs or incomplete scope',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{id:'44444444-4444-4444-8444-444444444444'}]});
 expect(await media.registerPendingMedia({query} as unknown as TenantTransaction,org,channel,{source:'CHATWOOT',sourceKey:'group:'+integrationId+':2:3:991:801',kind:'document',fileName:'synthetic.pdf',descriptor})).toBe('44444444-4444-4444-8444-444444444444');
 expect(JSON.parse(query.mock.calls[0]![1][6])).toEqual(descriptor);
 for(const bad of [{...descriptor,destinationRevision:undefined},{...descriptor,credentialRevision:undefined},{...descriptor,url:'https://untrusted.example.test'}])
  await expect(media.registerPendingMedia({query} as unknown as TenantTransaction,org,channel,{source:'CHATWOOT',sourceKey:'bad',kind:'document',fileName:'synthetic.pdf',descriptor:bad})).rejects.toThrow();
});
it('rejects group source destination or credential drift while preserving legacy descriptors',()=>{
 const guard=(media as unknown as Record<string,unknown>).assertChatwootMediaSnapshot;expect(typeof guard).toBe('function');
 const check=guard as (asset:unknown,current:unknown)=>void;
 const asset={source:'CHATWOOT',descriptor};expect(()=>check(asset,{destinationRevision:2,credentialRevision:3})).not.toThrow();
 for(const current of [{destinationRevision:3,credentialRevision:3},{destinationRevision:2,credentialRevision:4}])expect(()=>check(asset,current)).toThrow('MEDIA_CONTEXT_CHANGED');
 expect(()=>check({source:'CHATWOOT',descriptor:{integrationId,conversationId:51,messageId:991,attachmentId:801}},{destinationRevision:3,credentialRevision:4})).not.toThrow();
});
