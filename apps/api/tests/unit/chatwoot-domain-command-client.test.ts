import {expect,it,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {createHash} from 'node:crypto';
import {conversationEffectRequestHash} from '../../src/modules/automations/conversation-effect-protocol.js';
const id='11111111-1111-4111-8111-111111111111';
it('negotiates intake explicitly and accepts an independent Service Desk capability',async()=>{
 const fetch=vi.fn(async(_url:unknown)=>Response.json({protocol:'jrc-domain-commands/1',account_id:1,inbox_id:2,organization_id:id,
  integration_id:id,commands:['service_desk_intake','service_desk_status'],owners:[]}));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 expect((await client.flowDomainCapabilities(1,2,{organizationId:id,integrationId:id})).commands).toEqual(['service_desk_intake','service_desk_status']);
 expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('intake_protocol')).toBe('1');
});
it('pins domain capabilities to company, integration and inbox and rejects duplicate directory identities',async()=>{
 const body={protocol:'jrc-domain-commands/1',account_id:1,inbox_id:2,organization_id:id,integration_id:id,
  commands:['create_lead','create_task','create_meeting'],owners:[{id:7,name:'Synthetic operator'}]};
 const fetch=vi.fn(async()=>Response.json(body));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 expect((await client.flowDomainCapabilities(1,2,{organizationId:id,integrationId:id})).owners).toEqual(body.owners);
 fetch.mockResolvedValueOnce(Response.json({...body,inbox_id:3}));
 await expect(client.flowDomainCapabilities(1,2,{organizationId:id,integrationId:id})).rejects.toMatchObject({code:'CHATWOOT_BINDING_MISMATCH'});
 fetch.mockResolvedValueOnce(Response.json({...body,owners:[...body.owners,...body.owners]}));
 await expect(client.flowDomainCapabilities(1,2,{organizationId:id,integrationId:id})).rejects.toMatchObject({code:'CHATWOOT_INVALID_RESPONSE'});
});
it('dispatches a domain command once and keeps response loss uncertain without falling back to a native stock endpoint',async()=>{
 const fetch=vi.fn().mockRejectedValue(new Error('Synthetic disconnect'));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 const body={organization_id:id,integration_id:id,operation_id:id,dispatch_proof:id,inbox_id:'2',remote_contact_id:'4',
  expected_control_revision:'5',operation:'domain',value_json:'{"command":"create_lead"}'};
 await expect(client.applyFlowEffect(1,3,body)).rejects.toMatchObject({uncertain:true,retrySafe:false});
 expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0][0]).toBe('https://central.example.test/api/v1/accounts/1/conversations/3/jrc_domain_commands');
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
});
it('hands off through one proven local command, including when collection needs operator review',async()=>{
 const context={protocol:'jrc-conversation-effects/2',account_id:1,inbox_id:2,conversation_id:3,remote_contact_id:4,
  contact_inbox_id:5,actor_user_id:9,routing_source_hash:'a'.repeat(64),control_revision:6,status:'pending',
  assignee_id:null,team_id:null,assignee_agent_bot_id:null};
 const authorize=vi.fn(async()=>undefined),calls:{url:string;method:string}[]=[];
 const fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{
  calls.push({url:String(url),method:init?.method??'GET'});
  if(String(url).includes('/capabilities?'))return Response.json({protocol:'jrc-domain-commands/1',account_id:1,inbox_id:2,
   organization_id:id,integration_id:id,commands:['service_desk_handoff'],owners:[]});
  if(String(url).endsWith('/context'))return Response.json(context);
  expect(authorize).toHaveBeenCalledOnce();
  const request=JSON.parse(String(init?.body)),args=JSON.parse(request.value_json);
  expect(args).toMatchObject({command:'service_desk_handoff',phase:'handoff',target:{team_id:7,agent_id:null}});
  const {control_revision,status,assignee_id,team_id,assignee_agent_bot_id,...pins}=context;
  return Response.json({...pins,state:'CONFIRMED',operation:'domain',organization_id:id,operation_id:id,
   resource_id:null,resource_revision:null,control_revision_before:control_revision,control_revision_after:control_revision+1,
   message_id:null,request_hash:conversationEffectRequestHash({accountId:1,remoteConversationId:3},request),
   dispatch_proof_hash:createHash('sha256').update(id).digest('hex'),domain_result:{command:'service_desk_handoff',
    resource_type:'Conversation',resource_id:99,created:false,delivery:'NOT_APPLICABLE',episode_key:id,configuration_id:'8',
    handoff:{conversation_id:3,inbox_id:2,team_id:7,agent_id:null},intake:null,error_code:'intake_collection_invalid',
    event:{id,causation_id:id,type:'service_desk.handoff.recorded'}}});
 });
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 await client.handoffIntakeConversation(1,3,{scope:{organizationId:id,channelId:id,integrationId:id,destinationRevision:1,accountId:1,inboxId:2},
  operationId:id,dispatchProof:id,target:{teamId:7,agentId:null},authorize,
  intake:{configuration_id:8,configuration_revision:2,episode_key:id,input:{system:'example',location:'south',reason:'request',subject:'access',
   identifier:'00000000000',email:'invalid',description:'Synthetic help'}}});
 expect(calls.filter(c=>c.method==='POST')).toEqual([{method:'POST',url:'https://central.example.test/api/v1/accounts/1/conversations/3/jrc_domain_commands'}]);
 expect(new URL(calls[0]!.url).searchParams.get('intake_protocol')).toBe('2');
});
