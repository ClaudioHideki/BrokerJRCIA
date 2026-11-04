import {describe,expect,it} from 'vitest';
import {classifyChatwootAttendanceEvent} from '../../src/modules/integrations/chatwoot-attendance-events.js';
import {mayForwardChatwootAttendanceReply} from '../../src/modules/integrations/chatwoot-attendance-store.js';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';

const scope={organizationId:'11111111-1111-4111-8111-111111111111',channelId:'22222222-2222-4222-8222-222222222222',
  integrationId:'33333333-3333-4333-8333-333333333333',destinationRevision:1,credentialRevision:1,accountId:7,inboxId:9};
const invitation={event:'message_created',id:61,account:{id:7},inbox:{id:9},conversation:{id:51,inbox_id:9},
  message_type:'template',content_type:'input_csat',private:false,sender:null,content:'Avalie o atendimento https://example.test/survey/responses/synthetic'};

describe('native CSAT attendance admission',()=>{
  it.each(['template',3])('authorizes native CSAT %s as transport without human or bot control',async message_type=>{
    const classified=classifyChatwootAttendanceEvent({...invitation,message_type},scope)!;
    expect(classified).toEqual({kind:'NATIVE_CSAT',remoteConversationId:51,remoteMessageId:61,mayForwardReply:true,interruptsBot:false});
    const tx={query:()=>{throw Error('CSAT must not borrow another executor authority');}} as unknown as TenantTransaction;
    expect(await mayForwardChatwootAttendanceReply(tx,scope,classified)).toBe(true);
  });
  it.each([
    {content_type:undefined},{content_type:'text'},{private:true},{sender:{id:12,type:'user'}},
    {sender:{id:12,type:'agent_bot'}},{sender:{}},{sender:false},
    {attachments:[{id:1}]},{attachments:'malformed'},{content_type:9},{content_attributes:{jrc_broker_message_id:'echo'}},
  ])('does not admit another template as native CSAT: %j',patch=>{
    expect(classifyChatwootAttendanceEvent({...invitation,...patch},scope)).toMatchObject({kind:'SYSTEM_MESSAGE',mayForwardReply:false,interruptsBot:false});
  });
  it('rejects a cross-inbox CSAT before admitting transport',()=>{
    expect(()=>classifyChatwootAttendanceEvent({...invitation,conversation:{id:51,inbox_id:10}},scope)).toThrow('CHATWOOT_BINDING_MISMATCH');
  });
  it('retains human takeover even when its optional transport content is malformed',()=>{
    expect(classifyChatwootAttendanceEvent({...invitation,message_type:'outgoing',sender:{id:12,type:'user'},
      content_type:9,attachments:'malformed'},scope)).toMatchObject({kind:'HUMAN_PUBLIC',mayForwardReply:true,interruptsBot:true});
  });
});
