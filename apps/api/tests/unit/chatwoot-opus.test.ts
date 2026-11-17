import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {ChatwootClient} from '../../src/modules/integrations/chatwoot-client.js';

const opus=new Uint8Array(readFileSync(new URL('./synthetic-opus.ogg',import.meta.url)));
function client(bytes=opus,mime='audio/opus',fileType='audio',origin='https://central.example.test') {
 const fetch=vi.fn(async(input:URL|string|Request)=>{
  const url=new URL(String(input));
  if(url.pathname.endsWith('/conversations/51'))return Response.json({id:51,account_id:7,inbox_id:9});
  if(url.pathname.endsWith('/messages'))return Response.json({payload:[{id:41,attachments:[{id:71,account_id:7,message_id:41,file_type:fileType,data_url:origin+'/rails/active_storage/synthetic.ogg'}]}]});
  return new Response(bytes,{headers:{'content-type':mime}});
 });
 return {fetch,api:new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic-only',fetch})};
}
it.each(['audio/opus','Audio/Opus; codecs=opus'])('normalizes scoped Ogg Opus served as %s without changing bytes',async mime=>{
 const {api,fetch}=client(opus,mime);
 await expect(api.downloadAttachment(7,9,51,41,71)).resolves.toMatchObject({bytes:opus,mimeType:'audio/ogg',kind:'audio'});
 expect(fetch.mock.calls[2]?.[0].toString()).toContain('/rails/active_storage/');
});
it.each([
 {label:'raw Opus',bytes:new Uint8Array(Buffer.from('OpusHead'))},
 {label:'embedded signatures',bytes:new Uint8Array(Buffer.from('junkOggSOpusHead'))},
 {label:'truncated Ogg',bytes:opus.slice(0,40)},
 {label:'non Opus Ogg',bytes:opus.map((b,i)=>i===28?0:b)},
 {label:'missing BOS',bytes:opus.map((b,i)=>i===5?0:b)},
 {label:'invalid channels',bytes:opus.map((b,i)=>i===37?0:b)},
 {label:'invalid container version',bytes:opus.map((b,i)=>i===4?1:b)},
 {label:'invalid identification packet length',bytes:opus.map((b,i)=>i===27?18:b)},
 {label:'unsupported Opus version',bytes:opus.map((b,i)=>i===36?2:b)},
 {label:'unsupported channel mapping',bytes:opus.map((b,i)=>i===46?1:b)},
 {label:'high bit signature spoof',bytes:opus.map((b,i)=>i===0?b|128:b)},
])('rejects $label under audio/opus',async({bytes})=>{
 await expect(client(bytes).api.downloadAttachment(7,9,51,41,71)).rejects.toMatchObject({code:'MEDIA_TYPE_UNSUPPORTED'});
});
it.each(['application/octet-stream','application/ogg','audio/wav'])('does not infer audio from bytes under %s',async mime=>{
 await expect(client(opus,mime).api.downloadAttachment(7,9,51,41,71)).rejects.toMatchObject({code:'MEDIA_TYPE_UNSUPPORTED'});
});
it('requires the exact canonical audio descriptor',async()=>{
 await expect(client(opus,'audio/opus','file').api.downloadAttachment(7,9,51,41,71)).rejects.toMatchObject({code:'MEDIA_TYPE_UNSUPPORTED'});
});
it('preserves the attachment origin fence',async()=>{
 const {api,fetch}=client(opus,'audio/opus','audio','https://untrusted.example.test');
 await expect(api.downloadAttachment(7,9,51,41,71)).rejects.toMatchObject({code:'MEDIA_ORIGIN_NOT_ALLOWED'});
 expect(fetch).toHaveBeenCalledTimes(2);
});
