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
it.each([{status:'unexpected'},{meta:{}},{meta:{sender:{id:41},team:[]}},{meta:{sender:{id:41},assignee:{}}}])('rejects malformed conversation control metadata: %j',async patch=>{
  await expect(client({...conversation,...patch}).attendanceConversation(7,51)).rejects.toMatchObject({code:'CHATWOOT_INVALID_RESPONSE'});
});
it('normalizes omitted stock team metadata without discarding the assigned human',async()=>{
  const found=await client({...conversation,status:'open',meta:{sender:{id:41},assignee:{id:12},assignee_type:'User'}}).attendanceConversation(7,51);
  expect(found).toEqual({id:51,account_id:7,inbox_id:9,status:'open',updated_at:100.125,
    meta:{sender:{id:41},assignee:{id:12},assignee_type:'User',team:null}});
});
it('reads omitted stock assignments as unassigned while preserving the factual fractional clock',async()=>{
  const found=await client({...conversation,meta:{sender:{id:41}}}).attendanceConversation(7,51);
  expect(found).toEqual({id:51,account_id:7,inbox_id:9,status:'pending',updated_at:100.125,
    meta:{sender:{id:41},assignee:null,team:null}});
});
it('does not invent a control clock from another conversation timestamp',async()=>{
  const {updated_at:_,...withoutClock}=conversation;
  expect(await client({...withoutClock,last_activity_at:101,timestamp:101}).attendanceConversation(7,51)).not.toHaveProperty('updated_at');
});
