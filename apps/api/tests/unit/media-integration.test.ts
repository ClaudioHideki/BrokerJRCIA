import {expect,it,vi} from 'vitest';
import {normalizeQrEvent} from '../../src/modules/messaging/qr-events.js';
import {parseChatwootReply} from '../../src/modules/integrations/chatwoot-events.js';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';
import {dispatchClaim} from '../../src/modules/messaging/dispatcher.js';
import type {OutboxClaim} from '../../src/modules/messaging/types.js';
it('extrai apenas referência privada de mídia QR',()=>{
 const events=normalizeQrEvent({event:'messages.upsert',instance:'private',data:{key:{id:'asset-1',remoteJid:'15550000001@s.whatsapp.net'},messageTimestamp:1789470000,message:{imageMessage:{url:'https://untrusted.test',mediaKey:'secret',caption:'Foto'}}}},'private');
 expect(events[0]).toMatchObject({media:{kind:'image',source:'QR',descriptor:{messageId:'asset-1'}},caption:'Foto'});
 expect(JSON.stringify(events)).not.toMatch(/secret|untrusted/);
});
it('aceita anexos do Conversas por IDs, nunca pela URL recebida no evento',()=>{
 const reply=parseChatwootReply({event:'message_created',id:7,account:{id:1},inbox:{id:2},conversation:{id:3},message_type:'outgoing',private:false,content:null,attachments:[{id:8,file_type:'image',data_url:'http://127.0.0.1/secret'},{id:9,file_type:'file'}]},{accountId:1,inboxId:2});
 expect(reply).toMatchObject({attachments:[{id:8,kind:'image'},{id:9,kind:'document'}]});
 expect(JSON.stringify(reply)).not.toContain('127.0.0.1');
});
it('envia anexo ao Conversas por multipart preservando marcador antieco',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:42})));
 const client=new ChatwootClient({baseUrl:'https://conversas.test',token:'private-token',fetch});
 await client.sendMedia(1,2,{bytes:new Uint8Array([1,2]),mimeType:'image/png',fileName:'foto.png',kind:'image'}, {incoming:true,brokerMessageId:'broker-id'});
 const init=fetch.mock.calls[0]![1];expect(init.body).toBeInstanceOf(FormData);
 expect(JSON.parse(init.body.get('content_attributes'))).toEqual({jrc_broker_message_id:'broker-id'});
 expect(init.headers['Content-Type']).toBeUndefined();
});
it('revalida a autorização depois de preparar mídia e não envia com concessão expirada',async()=>{
 const claim={channel:{provider:'META'},contact:{externalId:'15550000001'},message:{content:{type:'MEDIA',mediaId:'asset',kind:'image',fileName:'foto.png'}}} as OutboxClaim;
 const send=vi.fn();const prepareMedia=vi.fn().mockResolvedValue(send);const validate=vi.fn().mockResolvedValue(false);
 await dispatchClaim(claim,{resolveClient:vi.fn().mockResolvedValue({}),prepareMedia,validate,complete:vi.fn()});
 expect(prepareMedia).toHaveBeenCalledOnce();expect(validate).toHaveBeenCalledOnce();expect(send).not.toHaveBeenCalled();
});
it('bloqueia download de anexo para origem interna e não envia token ao arquivo',async()=>{
 const replies=[{id:2,account_id:1,inbox_id:3,meta:{sender:{id:4,phone_number:'+15550000001'}}},{payload:[{id:5,attachments:[{id:6,file_type:'image',data_url:'http://127.0.0.1/private'}]}]}];
 const fetch=vi.fn().mockImplementation(async()=>Response.json(replies.shift()));
 const client=new ChatwootClient({baseUrl:'https://conversas.test',token:'private-token',fetch});
 await expect(client.downloadAttachment(1,3,2,5,6)).rejects.toMatchObject({code:'MEDIA_ORIGIN_NOT_ALLOWED'});expect(fetch).toHaveBeenCalledTimes(2);
});
