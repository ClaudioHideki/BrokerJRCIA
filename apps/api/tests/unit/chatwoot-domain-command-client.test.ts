import {expect,it,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
const id='11111111-1111-4111-8111-111111111111';
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
