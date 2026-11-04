import {describe,expect,it} from 'vitest';
import {parseChatwootReply} from '../../src/modules/integrations/chatwoot-events.js';

const scope={accountId:1,inboxId:8};
const invitation={event:'message_created',id:10,account:{id:1},inbox:{id:8},conversation:{id:20,inbox_id:8},
  message_type:'template',content_type:'input_csat',private:false,sender:null,
  content:'Por favor avalie nosso atendimento https://hml.example.test/survey/responses/11111111-1111-4111-8111-111111111111',
  content_attributes:{display_type:'emoji'}};

describe('native CSAT transport admission',()=>{
  it.each(['template',3])('transports a public native CSAT invitation represented as %s',message_type=>{
    expect(parseChatwootReply({...invitation,message_type},scope)).toEqual({messageId:10,conversationId:20,
      content:{type:'TEXT',text:invitation.content}});
  });
  it('does not confuse the same contact with another conversation',()=>{
    expect(parseChatwootReply({...invitation,id:11,conversation:{id:21,inbox_id:8}},scope)).toMatchObject({messageId:11,conversationId:21});
  });
  it.each([
    {content_type:'form'}, {content_type:undefined}, {private:true}, {event:'message_updated'},
    {sender:{id:7,type:'agent_bot'}}, {sender:{id:7,type:'user'}},
    {attachments:[{id:19,file_type:'image'}]},
    {content_attributes:{jrc_broker_message_id:'already-mirrored'}},
  ])('keeps unrelated templates, actors, private notes, media and echoes excluded: %j',patch=>{
    expect(parseChatwootReply({...invitation,...patch},scope)).toBeNull();
  });
  it('checks account and inbox before CSAT admission',()=>{
    expect(()=>parseChatwootReply(invitation,{...scope,accountId:2})).toThrow('CHATWOOT_BINDING_MISMATCH');
    expect(()=>parseChatwootReply({...invitation,conversation:{id:20,inbox_id:9}},scope)).toThrow('CHATWOOT_BINDING_MISMATCH');
  });
});
