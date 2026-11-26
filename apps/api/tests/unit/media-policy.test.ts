import {expect,it} from 'vitest';
import {EvolutionMessagingClient,mediaKind,validateMedia,MediaError,readMediaBytes,safeMediaName} from '@jrc/providers';
it('limits media by channel support and never uses filenames as paths',()=>{
 expect(mediaKind('audio/ogg; codecs=opus')).toBe('audio');
 expect(safeMediaName('../../arquivo\n.pdf')).not.toContain('/');
 expect(()=>validateMedia({bytes:new Uint8Array(6*1024*1024),kind:'image',mimeType:'image/jpeg',fileName:'photo.jpg'})).toThrow('MEDIA_SIZE_LIMIT');
 expect(()=>mediaKind('text/html')).toThrow('MEDIA_TYPE_UNSUPPORTED');
});
it('enforces actual streamed byte size even without a content-length header',async()=>{
 await expect(readMediaBytes(new Response(new Uint8Array(20)),10)).rejects.toBeInstanceOf(MediaError);
});

it('accepts a CSV and a ZIP from WhatsApp as documents without relying on the filename',()=>{
 const csv = new TextEncoder().encode('contato,horario\nexemplo,12:45\n');
 const emptyZip = new Uint8Array(22);
 emptyZip.set([0x50,0x4b,0x05,0x06]);
 for (const [mimeType, bytes] of [['text/csv', csv], ['application/zip', emptyZip]] as const) {
   expect(mediaKind(mimeType)).toBe('document');
   expect(()=>validateMedia({bytes,kind:'document',mimeType,fileName:'arquivo'})).not.toThrow();
 }
 expect(()=>validateMedia({bytes:csv,kind:'document',mimeType:'application/zip',fileName:'arquivo.zip'})).toThrow();
 expect(()=>validateMedia({bytes:emptyZip,kind:'document',mimeType:'text/csv',fileName:'arquivo.csv'})).toThrow();
 expect(()=>mediaKind('text/csv','meta')).toThrow('MEDIA_TYPE_UNSUPPORTED');
 expect(()=>mediaKind('application/x-zip-compressed','meta')).toThrow('MEDIA_TYPE_UNSUPPORTED');
});

it('normalizes a ZIP fetched from the QR engine before handing it to the inbox',async()=>{
 const emptyZip = Buffer.alloc(22);
 emptyZip.writeUInt32BE(0x504b0506);
 const client = new EvolutionMessagingClient({
   baseUrl:'https://engine.example.test', instanceKey:'fixture', apiKey:'fixture-token',
   fetch:async()=>Response.json({
     mimetype:'application/x-zip-compressed', base64:emptyZip.toString('base64'), fileName:'fixture.zip',
   }),
 });
 const media = await client.downloadMedia('fixture-message');
 expect(media).toMatchObject({mimeType:'application/zip',kind:'document',fileName:'fixture.zip'});
 expect(Buffer.from(media.bytes)).toEqual(emptyZip);
});
