import { expect, it, vi } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';

function client(payload: unknown) {
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
  return {api:new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic-token',fetch}),fetch};
}
it('reads bounded teams from the account and rejects a foreign account in the remote result',async()=>{
  const h=client([{id:4,name:'Suporte',account_id:7,allow_auto_assign:true,secret:'discard'}]);
  expect(await h.api.teams(7)).toEqual([{id:4,name:'Suporte',account_id:7,allow_auto_assign:true}]);
  expect(String(h.fetch.mock.calls[0]![0])).toBe('https://central.example.test/api/v1/accounts/7/teams');
  await expect(client([{id:4,name:'Foreign',account_id:8}]).api.teams(7)).rejects.toMatchObject({code:'CHATWOOT_BINDING_MISMATCH'});
});
it('normalizes labels, attribute definitions and team members without returning unrelated data',async()=>{
  expect(await client({payload:[{id:2,title:'financeiro',color:'#ffffff'}]}).api.labels(7)).toEqual([{id:2,title:'financeiro'}]);
  expect(await client([{id:3,attribute_key:'setor',attribute_display_name:'Setor',attribute_display_type:'list',attribute_model:'conversation_attribute',attribute_values:['Comercial'],regex_pattern:'secret'}]).api.attributeDefinitions(7))
    .toEqual([{id:3,attribute_key:'setor',attribute_display_name:'Setor',attribute_display_type:'list',attribute_model:'conversation_attribute',attribute_values:['Comercial']}]);
  expect(await client([{id:12,name:'Agente',email:'private@example.test',access_token:'secret'}]).api.teamAgents(7,4)).toEqual([{id:12,name:'Agente'}]);
});
it('reads inbox policy and working hours without promoting missing fields to supported',async()=>{
  const h=client({id:9,name:'Canal',channel_type:'Channel::Api',greeting_enabled:false,enable_auto_assignment:true,working_hours_enabled:true,timezone:'America/Sao_Paulo',working_hours:[{day_of_week:1,closed_all_day:false,open_all_day:false,open_hour:8,open_minutes:0,close_hour:18,close_minutes:0}],secret:'must-not-leak'});
  const inbox=await h.api.attendanceInbox(7,9);
  expect(inbox).toMatchObject({greeting_enabled:false,enable_auto_assignment:true,timezone:'America/Sao_Paulo'});
  expect(JSON.stringify(inbox)).not.toContain('must-not-leak');
  expect(await client({id:9,name:'Old',channel_type:'Channel::Api'}).api.attendanceInbox(7,9)).not.toHaveProperty('working_hours_enabled');
});
it('rejects unsafe IDs and malformed metadata with a sanitized error',async()=>{
  await expect(client([{id:Number.MAX_SAFE_INTEGER+1,name:'Unsafe',account_id:7}]).api.teams(7)).rejects.toMatchObject({code:'CHATWOOT_INVALID_RESPONSE'});
  await expect(client({id:9,name:'Canal',channel_type:'Channel::Api',working_hours:[{day_of_week:19}]}).api.attendanceInbox(7,9)).rejects.toMatchObject({code:'CHATWOOT_INVALID_RESPONSE'});
});
it('reads both empty and explicit-null stock agent bot responses as no bot',async()=>{
  expect(await client({}).api.inboxFlowBot(7,9)).toBeNull();
  expect(await client({agent_bot:null}).api.inboxFlowBot(7,9)).toBeNull();
});
it.each([{error:'unknown'},{agent_bot:{}},{agent_bot:[]},[],null])('does not mistake malformed bot data for an empty stock response: %j',async payload=>{
  await expect(client(payload).api.inboxFlowBot(7,9)).rejects.toMatchObject({code:'CHATWOOT_INVALID_RESPONSE'});
});
it('preserves a configured competing bot rather than normalizing it to absence',async()=>{
  expect(await client({agent_bot:{id:23,name:'Other bot'}}).api.inboxFlowBot(7,9)).toMatchObject({id:23,name:'Other bot'});
});
