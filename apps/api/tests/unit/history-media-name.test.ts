import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {safeMediaName} from '@jrc/providers';
import {createHistorySourceMedia} from '../../../../integrations/evolution-origin-journal/src/history-source-media.mjs';

for(const kind of ['image','audio','video','document','sticker'])it(`normalizes ${kind} source filenames exactly like QR ingress`,()=>{
 const scope={organizationId:randomUUID(),channelId:randomUUID(),instanceId:randomUUID(),sessionGeneration:randomUUID()},run=randomUUID();
 for(const name of [undefined,'..'+('x'.repeat(180))+'\\unsafe/file']){
  const jid='1'.repeat(11)+'@s.whatsapp.net',id='synthetic-media-name',media=createHistorySourceMedia({encryptionKey:Buffer.alloc(32,17),pool:{},transact:async()=>{throw Error('No IO');}});
  const raw={mediaKey:Buffer.alloc(32,11),fileSha256:Buffer.alloc(32,12),fileLength:20,directPath:'/v/synthetic.enc',
   mimetype:{image:'image/png',audio:'audio/ogg',video:'video/mp4',document:'application/pdf',sticker:'image/webp'}[kind],...(name?{fileName:name}:{})};
  const prepared=media.prepare(scope,run,randomUUID(),{'messaging-history.set':{messages:[{key:{id,remoteJid:jid,fromMe:false},message:{[kind+'Message']:raw}}]}});
  expect(prepared.resolve({chatJid:jid,providerMessageId:id,fromMe:false,mediaType:kind.toUpperCase()}).filename).toBe(safeMediaName(name??kind));
 }
});
