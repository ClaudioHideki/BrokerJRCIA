import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {liveIngressLookup} from '../../src/modules/integrations/chatwoot-live-ingress.js';

it.each(['missing','proxy','oversized','truncated','html','success','empty','conflict'] as const)('requires the scoped receiver to prove a missing receipt (%s)',async outcome=>{
 const calls:string[]=[];
 const client=new ChatwootClient({baseUrl:'https://synthetic.example.test',token:'fixture',async fetch(url,init){
   calls.push((init?.method??'GET')+' '+new URL(String(url)).pathname);
   if(outcome==='missing')return Response.json({error:'JRC_LIVE_RECEIPT_NOT_FOUND'},{status:404});
   if(outcome==='oversized')return Response.json({error:'JRC_LIVE_RECEIPT_NOT_FOUND',detail:'x'.repeat(4096)},{status:404});
   if(outcome==='truncated')return Response.json({error:'JRC_LIVE_RECEIPT_NOT_FOUND'},{status:404,headers:{'content-length':'500'}});
   if(outcome==='html')return new Response('<html/>',{status:404,headers:{'content-type':'text/html'}});
   if(outcome==='empty')return new Response(null,{status:404});
   if(outcome==='proxy')return Response.json({error:'not found'},{status:404});
   return Response.json({state:'MEDIA_PENDING'},{status:outcome==='conflict'?409:200});
 }});
 const scope={organization_id:randomUUID(),integration_id:randomUUID(),instance_id:randomUUID(),destination_revision:2};
 const envelope=client.liveIngress().prepare(scope,{broker_message_id:randomUUID(),conversation_id:51,message_type:'outgoing',
   message_origin:'EXTERNAL_OBSERVED',content:'[Saída observada no WhatsApp]\nSynthetic',occurred_at:1000});
 const check=()=>client.requireMissingLiveReceipt(7,9,liveIngressLookup(envelope));
 if(outcome==='missing')await expect(check()).resolves.toBeUndefined();
 else await expect(check()).rejects.toThrow();
 expect(calls).toEqual(['POST /api/v1/accounts/7/jrc_broker/inboxes/9/live-ingress/v1/receipts/'+envelope.broker_message_id]);
});
