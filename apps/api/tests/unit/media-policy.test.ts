import {expect,it} from 'vitest';
import {mediaKind,validateMedia,MediaError,readMediaBytes,safeMediaName} from '@jrc/providers';
it('limits media by channel support and never uses filenames as paths',()=>{
 expect(mediaKind('audio/ogg; codecs=opus')).toBe('audio');
 expect(safeMediaName('../../arquivo\n.pdf')).not.toContain('/');
 expect(()=>validateMedia({bytes:new Uint8Array(6*1024*1024),kind:'image',mimeType:'image/jpeg',fileName:'photo.jpg'})).toThrow('MEDIA_SIZE_LIMIT');
 expect(()=>mediaKind('text/html')).toThrow('MEDIA_TYPE_UNSUPPORTED');
});
it('enforces actual streamed byte size even without a content-length header',async()=>{
 await expect(readMediaBytes(new Response(new Uint8Array(20)),10)).rejects.toBeInstanceOf(MediaError);
});
