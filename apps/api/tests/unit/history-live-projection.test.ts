import {expect,it} from 'vitest';
import {projectLiveBatch,canonicalLive} from '../../../../integrations/evolution-origin-journal/src/live-projection.mjs';
import {normalizeQrEvent} from '../../src/modules/messaging/qr-events.js';
const binding={instanceName:'synthetic-source'};
const key={id:'synthetic-live',fromMe:false,remoteJid:`${'1'.repeat(11)}@s.whatsapp.net`};
const project=(message:unknown,k=key)=>projectLiveBatch(binding,{'messages.upsert':{type:'notify',messages:[{key:k,message,messageTimestamp:1600000000}]}});
for(const kind of ['image','audio','video','document','sticker'])it(`durably projects ${kind} through the existing normalizer without transport secrets`,()=>{
 const [body]=project({[kind+'Message']:{caption:'Synthetic caption',fileName:'synthetic.file',mimetype:'application/octet-stream',
   mediaKey:Buffer.alloc(32,7),url:'https://media.example.test/private',fileSha256:Buffer.alloc(32,8)}});
 expect(canonicalLive(binding,body)).toEqual(body);
 expect(normalizeQrEvent(body,binding.instanceName)[0]).toMatchObject({kind:'media',media:{kind}});
 expect(JSON.stringify(body)).not.toMatch(/mediaKey|url|fileSha256/);
});
it('preserves group and participant identity through the existing group contract',()=>{
 const [body]=project({extendedTextMessage:{text:'Synthetic group'}},{...key,remoteJid:'12345@g.us',participant:'123456789@lid'});
 expect(normalizeQrEvent(body,binding.instanceName)[0]).toMatchObject({kind:'group-text',groupJid:'12345@g.us',participantJid:'123456789@lid'});
});
it('preserves an unresolved LID without inventing its phone',()=>{
 const [body]=project({conversation:'Synthetic unresolved'},{...key,remoteJid:'123456789@lid'});
 expect(normalizeQrEvent(body,binding.instanceName)[0]).toMatchObject({kind:'identity-pending',lid:'123456789@lid'});
});
it('captures group binary through its explicit group contract and does not own a history append',()=>{
 const [body]=project({imageMessage:{caption:'Synthetic'}},{...key,remoteJid:'12345@g.us',participant:'123456789@lid'});
 expect(normalizeQrEvent(body,binding.instanceName)[0]).toMatchObject({kind:'group-media',groupJid:'12345@g.us',participantJid:'123456789@lid'});
 expect(projectLiveBatch(binding,{'messages.upsert':{type:'append',messages:[{key,message:{conversation:'Synthetic'},messageTimestamp:1600000000}]}})).toEqual([]);
});
it('snapshots allowlisted values before source mutation and refuses altered canonical envelopes',()=>{
 const message={audioMessage:{caption:'Synthetic',fileName:'voice.ogg'}},[body]=project(message);
 message.audioMessage.caption='Changed';expect(body.data.message.audioMessage.caption).toBe('Synthetic');
 expect(()=>canonicalLive(binding,{...body,credential:'synthetic-untrusted'})).toThrow('ORIGIN_LIVE_INVALID');
});
