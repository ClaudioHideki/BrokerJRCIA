import {describe,it,expect,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
const key='a'.repeat(64),identifier='jrc-group-'+key;
const contact={name:'Grupo · Suporte',identifier,additional_attributes:{jrc_broker_recipient_kind:'GROUP' as const,jrc_broker_group_scope:key}};
describe('group display envelope client',()=>{
 it('creates an explicit group envelope without telephone, email or implicit inbox binding',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({payload:{contact:{id:7}}})));
  const client=new ChatwootClient({baseUrl:'https://central.test',token:'synthetic',fetch});
  expect(await client.createGroupContact(1,contact)).toBe(7);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(contact);
  expect(fetch.mock.calls[0]![1].method).toBe('POST');
 });
 it('finds only exact scoped groups and rejects an individual masquerading as group',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({payload:[{id:7,...contact,phone_number:null,email:null}]})));
  const client=new ChatwootClient({baseUrl:'https://central.test',token:'synthetic',fetch});
  expect(await client.findGroupContact(1,identifier,key)).toBe(7);
  fetch.mockResolvedValue(new Response(JSON.stringify({payload:[{id:7,...contact,phone_number:'+5511999999999'}]})));
  await expect(client.findGroupContact(1,identifier,key)).rejects.toMatchObject({code:'CHATWOOT_GROUP_CONTACT_MISMATCH'});
 });
 it('does not select an ambiguous or unscoped search result',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({payload:[{id:7,...contact},{id:8,...contact}]})));
  const client=new ChatwootClient({baseUrl:'https://central.test',token:'synthetic',fetch});
  await expect(client.findGroupContact(1,identifier,key)).rejects.toMatchObject({code:'CHATWOOT_CONTACT_AMBIGUOUS'});
  fetch.mockResolvedValue(new Response(JSON.stringify({payload:[{id:7,identifier,name:'Person'}]})));
  await expect(client.findGroupContact(1,identifier,key)).rejects.toMatchObject({code:'CHATWOOT_GROUP_CONTACT_MISMATCH'});
 });
 it('leaves an uncertain create uncertain and performs no automatic retry',async()=>{
  const fetch=vi.fn().mockRejectedValue(new Error('synthetic transport loss'));
  const client=new ChatwootClient({baseUrl:'https://central.test',token:'synthetic',fetch});
  await expect(client.createGroupContact(1,contact)).rejects.toMatchObject({code:'CHATWOOT_OUTCOME_UNKNOWN',uncertain:true});
  expect(fetch).toHaveBeenCalledTimes(1);
 });
});
