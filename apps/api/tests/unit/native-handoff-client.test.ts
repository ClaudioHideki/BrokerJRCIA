import { describe, expect, it } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';

describe('native handoff Chatwoot wire contract', () => {
  function fixture() {
    const writes:Array<{url:string;body:unknown}>=[];
    const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async(input,init)=>{
      writes.push({url:String(input),body:JSON.parse(String(init?.body))});
      return Response.json({id:9,name:'Synthetic',channel_type:'Channel::Api'});
    }});
    return {client,writes};
  }
  it('omits assignee_id for team-only assignment (null makes stock Chatwoot ignore team)',async()=>{
    const {client,writes}=fixture();
    await client.assignAttendanceConversation(7,21,{teamId:3,agentId:null});
    expect(writes[0]).toEqual({url:'https://central.example.test/api/v1/accounts/7/conversations/21/assignments',body:{team_id:3}});
  });
  it('sends exactly the chosen agent and rejects zero/two targets before HTTP',async()=>{
    const {client,writes}=fixture();
    await client.assignAttendanceConversation(7,21,{teamId:null,agentId:4});
    expect(writes[0]?.body).toEqual({assignee_id:4});
    await expect(client.assignAttendanceConversation(7,21,{teamId:null,agentId:null})).rejects.toThrow();
    await expect(client.assignAttendanceConversation(7,21,{teamId:3,agentId:4})).rejects.toThrow();
    expect(writes).toHaveLength(1);
  });
  it('creates inbox with both greeting and autoassignment off',async()=>{
    const {client,writes}=fixture(); await client.createInbox(7,'Synthetic','https://broker.example.test/callback');
    expect(writes[0]?.body).toMatchObject({greeting_enabled:false,enable_auto_assignment:false});
  });
});
