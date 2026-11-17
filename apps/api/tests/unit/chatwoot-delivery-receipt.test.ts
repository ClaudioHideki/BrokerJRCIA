import {expect,it} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';

const canonical='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(){const requests:{path:string;body:Record<string,unknown>}[]=[];
  const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic-token',async fetch(input,init){
    requests.push({path:new URL(String(input)).pathname,body:JSON.parse(String(init?.body))});return Response.json({});}});
  return {client,requests};}

it('sends optional canonical/provider evidence with the current status PATCH',async()=>{
  const t=fixture(),proof={version:1 as const,canonical_message_id:canonical,provider_message_id:'synthetic-provider-id',state:'DELIVERED' as const};
  await t.client.updateMessageStatus(7,52,701,'delivered',undefined,proof);
  expect(t.requests).toEqual([{path:'/api/v1/accounts/7/conversations/52/messages/701',body:{status:'delivered',broker_delivery:proof}}]);
});

it('preserves the legacy consumer status payload when no proof is supplied',async()=>{
  const t=fixture();await t.client.updateMessageStatus(7,52,701,'sent');
  expect(t.requests[0]?.body).toEqual({status:'sent'});
});

it.each(['missing-provider','different-state','extra-field'] as const)('does not send invalid %s delivery evidence',async kind=>{
  const t=fixture(),proof:Record<string,unknown>={version:1,canonical_message_id:canonical,provider_message_id:'synthetic-provider-id',state:'SENT'};
  if(kind==='missing-provider')proof.provider_message_id=null;
  if(kind==='different-state')proof.state='READ';
  if(kind==='extra-field')proof.untrusted='not allowed';
  await expect(t.client.updateMessageStatus(7,52,701,'sent',undefined,proof as never)).rejects.toMatchObject({code:'CHATWOOT_DELIVERY_RECEIPT_INVALID'});
  expect(t.requests).toEqual([]);
});

it('can report a confirmed failure without fabricating a provider ID',async()=>{
  const t=fixture(),proof={version:1 as const,canonical_message_id:canonical,provider_message_id:null,state:'FAILED' as const};
  await t.client.updateMessageStatus(7,52,701,'failed','MEDIA_UNAVAILABLE',proof);
  expect(t.requests[0]?.body).toEqual({status:'failed',external_error:'MEDIA_UNAVAILABLE',broker_delivery:proof});
});
