import { expect,it,vi } from 'vitest';
import { MetaCloudClient } from '../src/meta/cloud-client.js';
import { EvolutionMessagingClient } from '../src/evolution/messaging.js';
const png=new Uint8Array([137,80,78,71,13,10,26,10]);
const media={bytes:png,mimeType:'image/png',fileName:'teste.png',kind:'image' as const};
it('uploads binary media to the bound Meta phone then sends only the resulting media ID',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(Response.json({id:'123456789'})).mockResolvedValueOnce(Response.json({messages:[{id:'wamid.test'}]}));
 const client=new MetaCloudClient({accessToken:'secret',graphVersion:'v25.0',phoneNumberId:'12345',wabaId:'67890',fetch});
 const id=await client.uploadMedia(media);
 await client.sendMedia('15550000001',{id,kind:'image',caption:'Imagem'});
 expect(String(fetch.mock.calls[0]![0])).toBe('https://graph.facebook.com/v25.0/12345/media');
 expect(fetch.mock.calls[0]![1].body).toBeInstanceOf(FormData);
 expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({type:'image',image:{id:'123456789',caption:'Imagem'}});
});
it('checks phone ownership and never forwards a Meta token to an arbitrary media host',async()=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({url:'https://attacker.test/secret',mime_type:'image/png',file_size:8,id:'123456789'}));
 const client=new MetaCloudClient({accessToken:'secret',graphVersion:'v25.0',phoneNumberId:'12345',wabaId:'67890',fetch});
 await expect(client.downloadMedia('123456789')).rejects.toMatchObject({code:'MEDIA_ORIGIN_REJECTED'});
 expect(String(fetch.mock.calls[0]![0])).toContain('phone_number_id=12345');
 expect(fetch).toHaveBeenCalledTimes(1);
});
it('fetches QR media by stored message ID and sends bytes without a public URL',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(Response.json({base64:Buffer.from(png).toString('base64'),mimetype:'image/png',fileName:'teste.png'})).mockResolvedValueOnce(Response.json({key:{id:'qr-media-id'}}));
 const client=new EvolutionMessagingClient({baseUrl:'https://engine.test',apiKey:'private',instanceKey:'private-instance',fetch});
 const downloaded=await client.downloadMedia('qr-incoming-id');
 expect(downloaded.bytes).toEqual(png);
 await client.sendMedia('15550000001',media);
 expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({message:{key:{id:'qr-incoming-id'}},convertToMp4:false});
 expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({number:'15550000001',mediatype:'image',media:Buffer.from(png).toString('base64')});
});
