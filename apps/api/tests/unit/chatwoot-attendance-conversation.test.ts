import { expect,it,vi } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
const conversation={id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100.125,
  meta:{sender:{id:41,email:'private@example.test'},assignee:null,assignee_type:null,team:null}};
function client(payload:unknown){return new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)))});}
it('reads canonical conversation control without returning contact PII',async()=>{
  const found=await client(conversation).attendanceConversation(7,51);
  expect(found).toMatchObject({id:51,status:'pending',meta:{sender:{id:41},assignee:null},updated_at:100.125});
  expect(JSON.stringify(found)).not.toContain('private@example');
});
it.each([{id:52},{account_id:8}])('rejects a canonical response for another resource: %j',async patch=>{
  await expect(client({...conversation,...patch}).attendanceConversation(7,51)).rejects.toMatchObject({code:'CHATWOOT_BINDING_MISMATCH'});
});
it.each([{status:'unexpected'},{meta:{sender:{id:41}}}])('does not accept missing control metadata as unassigned: %j',async patch=>{
  await expect(client({...conversation,...patch}).attendanceConversation(7,51)).rejects.toMatchObject({code:'CHATWOOT_INVALID_RESPONSE'});
});
