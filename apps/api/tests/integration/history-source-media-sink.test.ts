import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createMediaStore } from '../../src/modules/messaging/media-store.js';

it('retains the captured reference identity and verifies bytes under current authority; replay cannot choose another tenant or content',async()=>{
  const db=await attendanceDatabase();
  try {
    const t=await seedAttendanceTenant(db.database);
    const media=createMediaStore({transact:db.transact,encryptionKey:Buffer.alloc(32,67).toString('base64'),download:async()=>{throw Error('No network');}});
    const bytes=new Uint8Array(Buffer.from('%PDF-1.7\nsynthetic private document\n%%EOF'));
    const identity={uploadKind:'HISTORY' as const,referenceId:randomUUID(),runId:randomUUID(),captureScopeKey:'a'.repeat(64),
      sha256:createHash('sha256').update(bytes).digest('hex')};
    const file={bytes,mimeType:'application/pdf',fileName:'synthetic.pdf',kind:'document' as const};
    const control={authorize:async()=>{}};
    expect(await media.writeHistoryUpload(t.org,t.channel,identity,file,control)).toBe(identity.referenceId);
    expect(await media.writeHistoryUpload(t.org,t.channel,identity,file,control)).toBe(identity.referenceId);
    expect((await media.read(t.org,identity.referenceId)).bytes).toEqual(bytes);
    expect((await db.database.pool.query('SELECT count(*) FROM messaging_media WHERE id=$1',[identity.referenceId])).rows[0].count).toBe('1');
    await expect(media.writeHistoryUpload(t.org,t.channel,identity,{...file,bytes:new Uint8Array(Buffer.from('%PDF-1.7\nchanged\n%%EOF'))},control)).rejects.toThrow();
    await expect(media.writeHistoryUpload(t.org,t.channel,{...identity,runId:randomUUID()},file,control)).rejects.toThrow();
    const other=await seedAttendanceTenant(db.database);
    await expect(media.writeHistoryUpload(other.org,other.channel,identity,file,control)).rejects.toThrow();
    const revoked={...identity,referenceId:randomUUID()};
    await expect(media.writeHistoryUpload(t.org,t.channel,revoked,file,{authorize:async()=>{throw Error('REVOKED');}})).rejects.toThrow('REVOKED');
    expect((await db.database.pool.query('SELECT count(*) FROM messaging_media WHERE id=$1',[revoked.referenceId])).rows[0].count).toBe('0');
    for(const historical of [{mimeType:'image/webp',kind:'sticker' as const},{mimeType:'audio/ogg; codecs=opus',kind:'audio' as const},
      {mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',kind:'document' as const}]) {
      const source={...identity,referenceId:randomUUID()};
      expect(await media.writeHistoryUpload(t.org,t.channel,source,{...file,...historical},control)).toBe(source.referenceId);
      expect((await media.read(t.org,source.referenceId)).mimeType).toBe(historical.mimeType);
    }
  } finally {await db.dispose();}
},60000);
