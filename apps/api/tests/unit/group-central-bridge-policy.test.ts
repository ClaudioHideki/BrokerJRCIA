import {expect,it} from 'vitest';
import {groupMirrorText,requireGroupReply} from '../../src/modules/whatsapp-groups/bridge-policy.js';
it('keeps participant identity in incoming group messages and does not attribute a device message to an agent',()=>{
 expect(groupMirrorText({direction:'INCOMING',source:'PROVIDER',text:'hello',participant:'123@lid'})).toBe('[Participante: 123@lid]\nhello');
 expect(groupMirrorText({direction:'OUTGOING',source:'EXTERNAL_OBSERVED',text:'device',participant:null})).toBe('[Saída observada no WhatsApp]\ndevice');
 expect(groupMirrorText({direction:'OUTGOING',source:'AUTOMATION',text:'menu',participant:null})).toBe('menu');
 expect(()=>groupMirrorText({direction:'INCOMING',source:'PROVIDER',text:'hello',participant:null})).toThrow();
});
it('accepts only the observed public human reply, and rejects private/bot/media or legacy payloads',()=>{
 const good={attendanceObservationId:'11111111-1111-4111-8111-111111111111',attendanceKind:'HUMAN_PUBLIC',destinationRevision:1,messageId:12,conversationId:3,content:{type:'TEXT',text:'answer'}};
 expect(requireGroupReply(good).content?.text).toBe('answer');
 for(const bad of [{...good,attendanceKind:'HUMAN_PRIVATE'},{...good,attendanceKind:'EXTERNAL_BOT'},{...good,attendanceObservationId:undefined},{...good,attachments:[{}]},{...good,content:{type:'MEDIA'}}])expect(()=>requireGroupReply(bad)).toThrow();
});

it('accepts explicit human media attachment IDs only with a durable outbound intent and bounded original caption',()=>{
 const good={attendanceObservationId:'11111111-1111-4111-8111-111111111111',attendanceKind:'HUMAN_PUBLIC',destinationRevision:2,
  outboundIntentId:'22222222-2222-4222-8222-222222222222',messageId:12,conversationId:3,attachments:[{id:81,kind:'image'},{id:82,kind:'document'}],caption:'c'.repeat(1024)};
 expect(requireGroupReply(good)).toMatchObject(good);
 for(const bad of [{...good,outboundIntentId:undefined},{...good,attachments:[{id:81,kind:'image'},{id:81,kind:'image'}]},
  {...good,content:{type:'TEXT',text:'mixed'}},{...good,caption:'x'.repeat(1025)},{...good,attachments:[{id:81,kind:'image',url:'https://untrusted.example.test'}]},
  {...good,attendanceKind:'HUMAN_PRIVATE'},{...good,attendanceKind:'EXTERNAL_BOT'}])expect(()=>requireGroupReply(bad)).toThrow();
});
