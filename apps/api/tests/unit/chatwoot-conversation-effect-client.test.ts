import {expect,it,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
const operation_id='11111111-1111-4111-8111-111111111111';
const input={organization_id:operation_id,operation_id,dispatch_proof:operation_id,inbox_id:'2',remote_contact_id:'4',
  expected_control_revision:'5',operation:'note' as const,value_json:'"Private"'};
const context={protocol:'jrc-conversation-effects/2',account_id:1,inbox_id:2,conversation_id:3,remote_contact_id:4,
  contact_inbox_id:8,actor_user_id:6,routing_source_hash:'a'.repeat(64),control_revision:5,status:'pending',
  assignee_id:null,assignee_agent_bot_id:null,team_id:null};
const receipt={...context,state:'CONFIRMED',organization_id:operation_id,operation_id,operation:'note',resource_id:null,
  resource_revision:null,request_hash:'b'.repeat(64),dispatch_proof_hash:'c'.repeat(64),control_revision_before:5,control_revision_after:6,message_id:7};
const receiptBody=Object.fromEntries(Object.entries(receipt).filter(([key])=>!['control_revision','status','assignee_id','assignee_agent_bot_id','team_id'].includes(key)));
const response=(body:unknown)=>new Response(JSON.stringify(body));

it('loads only the protocol2 capability with exact Account and Inbox',async()=>{
  const fetch=vi.fn().mockResolvedValue(response({protocol:'jrc-conversation-effects/2',account_id:1,inbox_id:2,
    control_revision_supported:true,operations:['tag','attribute','note','resolve'],resources:[]}));
  const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
  expect((await client.flowEffectCapabilities(1,2)).operations).toEqual(['tag','attribute','note','resolve']);
  fetch.mockResolvedValueOnce(response({protocol:'jrc-conversation-effects/1',account_id:1,inbox_id:2,operations:['tag','attribute'],resources:[]}));
  await expect(client.flowEffectCapabilities(1,2)).rejects.toMatchObject({code:'CHATWOOT_INVALID_RESPONSE'});
});

it('pins the current contact and routing revision from the authenticated context',async()=>{
  const fetch=vi.fn().mockResolvedValue(response(context));
  const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
  expect(await client.flowEffectContext(1,2,3)).toEqual(context);
  fetch.mockResolvedValueOnce(response({...context,inbox_id:9}));
  await expect(client.flowEffectContext(1,2,3)).rejects.toMatchObject({code:'CHATWOOT_BINDING_MISMATCH'});
});

it('preserves raw value_json bytes on one POST and uses only GET for receipt recovery',async()=>{
  const fetch=vi.fn().mockImplementation(async()=>response(receiptBody));
  const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
  expect(await client.applyFlowEffect(1,3,input)).toEqual(receiptBody);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input);
  expect(fetch.mock.calls[0]![1]).toMatchObject({method:'POST',redirect:'error',headers:{api_access_token:'synthetic'}});
  await client.flowEffectReceipt(1,3,{organizationId:operation_id,operationId:operation_id,dispatchProof:operation_id});
  expect(fetch.mock.calls[1]![1].method).toBe('GET');
  expect(fetch.mock.calls[1]![0]).toContain(`/conversations/3/jrc_flow_effects/${operation_id}?organization_id=`);
});

it('does not retry an uncertain mutation or substitute a stock private-message endpoint',async()=>{
  const fetch=vi.fn().mockRejectedValue(new Error('lost ACK'));
  const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch}).withRequestTimeout(100);
  await expect(client.applyFlowEffect(1,3,input)).rejects.toMatchObject({uncertain:true,retrySafe:false});
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toBe('https://central.example.test/api/v1/accounts/1/conversations/3/jrc_flow_effects');
});

it('rejects invalid input before dispatch and marks a malformed success ACK uncertain',async()=>{
  const fetch=vi.fn().mockImplementation(async()=>response({...receiptBody,message_id:null}));
  const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
  await expect(client.applyFlowEffect(1,3,{...input,inbox_id:'02'})).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(client.applyFlowEffect(1,3,input)).rejects.toMatchObject({uncertain:true,retrySafe:false});
  expect(fetch).toHaveBeenCalledTimes(1);
});
