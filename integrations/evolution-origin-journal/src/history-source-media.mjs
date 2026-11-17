import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { historyCaptureScopeKey, historyProjectionDigest } from './history-projection.mjs';

const MAX_BYTES = 16 * 1024 * 1024;
const fields = { IMAGE: 'imageMessage', AUDIO: 'audioMessage', VIDEO: 'videoMessage', DOCUMENT: 'documentMessage', STICKER: 'stickerMessage' };
const supported = { IMAGE:['image/jpeg','image/png'],STICKER:['image/webp'],AUDIO:['audio/aac','audio/mp4','audio/mpeg','audio/amr','audio/ogg'],
  VIDEO:['video/mp4','video/3gpp'],DOCUMENT:['application/pdf','text/plain','application/msword','application/vnd.ms-excel','application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'] };
const binary = value => (Buffer.isBuffer(value) || value instanceof Uint8Array) && value.length === 32 ? Buffer.from(value) : null;
const size = value => typeof value === 'number' ? value : typeof value?.low === 'number' && typeof value?.high === 'number'
  ? (value.low >>> 0) + (value.high >>> 0) * 4294967296 : NaN;
const identity = value => JSON.stringify([value.chatJid, value.providerMessageId, value.fromMe]);
function bodyOf(message) {
  let body = message?.message;
  for (let i = 0; i < 4 && body; i++) {
    const wrapped = body.ephemeralMessage?.message ?? body.viewOnceMessage?.message ?? body.viewOnceMessageV2?.message ?? body.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    body = wrapped;
  }
  return body;
}
const referenceId = value => {
  const b = Buffer.from(historyProjectionDigest(value).slice(0, 32), 'hex'); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
};

/** Private media obligations in the SAME encrypted source transaction as their
 * pages. A projected reference means pending bytes, never a custody receipt. */
export function createHistorySourceMedia({ pool, encryptionKey, transact }) {
  const key = Buffer.from(encryptionKey);
  const aad = (scopeKey, runId, id, hash) => Buffer.from(JSON.stringify(['history-media:2', scopeKey, runId, id, hash]));
  const open = row => {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.descriptor_iv);
      decipher.setAAD(aad(row.scope_key,row.run_id,row.reference_id,row.descriptor_hash)); decipher.setAuthTag(row.descriptor_tag);
      const value = JSON.parse(Buffer.concat([decipher.update(row.descriptor_ciphertext),decipher.final()]).toString('utf8'));
      if (historyProjectionDigest(value) !== row.descriptor_hash) throw Error();
      return value;
    } catch { throw Error('HISTORY_SOURCE_MEDIA_PRIVATE_PAYLOAD_INVALID'); }
  };
  return Object.freeze({
    prepare(scope, runId, captureId, events,live=false) {
      const scopeKey = historyCaptureScopeKey(scope), messages = new Map(), snapshots = new Map();
      for (const message of (live?events?.['messages.upsert']?.messages:events?.['messaging-history.set']?.messages) ?? []) {
        const k = identity({ chatJid:message?.key?.remoteJid,providerMessageId:message?.key?.id,fromMe:message?.key?.fromMe });
        // Ambiguous duplicate input cannot choose which encryption descriptor to trust.
        messages.set(k, messages.has(k) ? null : message);
      }
      return { snapshots, resolve(request) {
        const k = identity(request); if (snapshots.has(k)) return snapshots.get(k).reference;
        const raw = bodyOf(messages.get(k))?.[fields[request.mediaType]];
        const mediaKey = binary(raw?.mediaKey), sha = binary(raw?.fileSha256), byteSize = size(raw?.fileLength);
        if (!mediaKey || !sha || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_BYTES
          || typeof raw.directPath !== 'string' || !/^\/(?!\/)[A-Za-z\d._~!$&'()*+,;=:@%/?-]{1,4000}$/u.test(raw.directPath)
          || typeof raw.mimetype !== 'string' || !/^[a-z\d.+-]+\/[a-z\d.+-]+(?:;\s*codecs=opus)?$/iu.test(raw.mimetype)
          || !supported[request.mediaType]?.includes(raw.mimetype.toLowerCase().split(';')[0].trim())
          || request.mediaType==='IMAGE'&&byteSize>5*1024*1024 || request.mediaType==='STICKER'&&byteSize>500*1024
          || (raw.caption !== undefined && (typeof raw.caption !== 'string' || raw.caption.length > 4096))) return null;
        const liveSourceKey=live?(request.chatJid.endsWith('@g.us')?`group:${request.chatJid}:${request.providerMessageId}`:request.providerMessageId):null;
        const liveMessageKey=liveSourceKey===null?null:createHash('sha256').update(liveSourceKey).digest('hex');
        const id = referenceId(live?[scopeKey,runId,'LIVE',liveMessageKey]:[scopeKey,runId,captureId,k]);
        // Match the existing QR safeMediaName contract; proved bytes do not
        // converge if the historical and live lanes invent different names.
        const filename=(typeof raw.fileName==='string'?raw.fileName:request.mediaType.toLowerCase())
          .replace(/[\u0000-\u001f\u007f/\\]/gu,'_').replace(/^\.+/u,'').slice(0,120)||'arquivo';
        const reference = { referenceId:id,mediaType:request.mediaType,byteSize,sha256:sha.toString('hex'),
          mimeType:raw.mimetype.toLowerCase().split(';')[0].trim(),filename,caption:raw.caption ?? '' };
        const value = { reference,descriptor:{ mediaType:request.mediaType,mediaKey:mediaKey.toString('base64'),directPath:raw.directPath },...(live?{liveSourceKey}:{} ) };
        const hash = historyProjectionDigest(value), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv);
        cipher.setAAD(aad(scopeKey,runId,id,hash));
        const plaintext = Buffer.from(JSON.stringify(value)), ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]); plaintext.fill(0);
        snapshots.set(k,{ reference,scopeKey,runId,captureId,liveMessageKey,hash,iv,ciphertext,tag:cipher.getAuthTag() });
        return reference;
      } };
    },
    async append(client, snapshots) {
      for (const m of snapshots) {
        const row=(await client.query(`INSERT INTO jrc_evolution_origin.history_media
          (scope_key,run_id,capture_id,reference_id,descriptor_hash,descriptor_bytes,descriptor_ciphertext,descriptor_iv,descriptor_tag,live_message_key)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(scope_key,run_id,reference_id)
          DO UPDATE SET reference_id=history_media.reference_id RETURNING descriptor_hash`,
          [m.scopeKey,m.runId,m.captureId,m.reference.referenceId,m.hash,m.ciphertext.length,m.ciphertext,m.iv,m.tag,m.liveMessageKey])).rows[0];
        if(row?.descriptor_hash!==m.hash)throw Error('HISTORY_SOURCE_MEDIA_CONFLICT');
      }
    },
    async readLive(scope,runId,sourceKey) {
      const row=(await pool.query(`SELECT * FROM jrc_evolution_origin.history_media WHERE scope_key=$1 AND run_id=$2 AND live_message_key=$3`,
        [historyCaptureScopeKey(scope),runId,createHash('sha256').update(sourceKey).digest('hex')])).rows[0];
      if(!row)return null;
      const value=open(row);if(value.liveSourceKey!==sourceKey)throw Error('HISTORY_SOURCE_MEDIA_CONFLICT');
      return value;
    },
    async claimMedia(scope,runId,now) {
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw Error('HISTORY_SOURCE_CLOCK_INVALID');
      const scopeKey = historyCaptureScopeKey(scope), lease = randomUUID();
      return transact(async client => {
        const row = (await client.query(`WITH candidate AS (
          SELECT reference_id FROM jrc_evolution_origin.history_media WHERE scope_key=$1 AND run_id=$2 AND live_message_key IS NULL
          AND ((state='PENDING' AND next_attempt_at<=$3) OR (state='CLAIMED' AND lease_until<=$3))
          ORDER BY attempts,created_at,reference_id FOR UPDATE SKIP LOCKED LIMIT 1)
          UPDATE jrc_evolution_origin.history_media m SET state='CLAIMED',lease_token=$4,lease_until=$3::timestamptz+interval '60 seconds',attempts=attempts+1
          FROM candidate c WHERE m.scope_key=$1 AND m.run_id=$2 AND m.reference_id=c.reference_id RETURNING m.*`,[scopeKey,runId,now,lease])).rows[0];
        return row ? Object.freeze({ ...open(row),scopeKey,runId,leaseToken:lease }) : null;
      });
    },
    async settleMedia(scope,claim,receipt,now,assertCurrentScope) {
      const s=Object.freeze({...scope}),r=Object.freeze({...receipt}),c=Object.freeze({scopeKey:claim.scopeKey,runId:claim.runId,
        referenceId:claim.reference.referenceId,sha256:claim.reference.sha256,byteSize:claim.reference.byteSize,leaseToken:claim.leaseToken});
      const at=new Date(now.getTime());
      if (r.protocol !== 'jrc-history-media/2' || r.persisted !== true || r.scopeKey !== historyCaptureScopeKey(s)
        || c.scopeKey !== r.scopeKey || r.runId !== c.runId || r.referenceId !== c.referenceId
        || r.sha256 !== c.sha256 || r.byteSize !== c.byteSize) return false;
      if (typeof assertCurrentScope !== 'function') throw Error('HISTORY_SOURCE_MEDIA_AUTHORITY_REQUIRED');
      return transact(async client => {
        await assertCurrentScope(client,s);
        const row=(await client.query(`SELECT * FROM jrc_evolution_origin.history_media WHERE scope_key=$1 AND run_id=$2 AND reference_id=$3
          AND state='CLAIMED' AND lease_token=$4 AND lease_until>$5 FOR UPDATE`,[c.scopeKey,c.runId,c.referenceId,c.leaseToken,at])).rows[0];
        if(!row)return false;
        const original=open(row).reference;
        if(original.referenceId!==r.referenceId||original.sha256!==r.sha256||original.byteSize!==r.byteSize)return false;
        return (await client.query(`UPDATE jrc_evolution_origin.history_media SET state='READY',lease_token=NULL,lease_until=NULL,
          persisted_at=$5,last_error=NULL WHERE scope_key=$1 AND run_id=$2 AND reference_id=$3 AND state='CLAIMED' AND lease_token=$4 AND lease_until>$5 RETURNING reference_id`,
        [c.scopeKey,c.runId,c.referenceId,c.leaseToken,at])).rowCount === 1;
      });
    },
    async retryMedia(scope,claim,code,now) {
      if (!['DOWNLOAD_FAILED','INTEGRITY_FAILED','PERSISTENCE_UNCERTAIN','AUTHORITY_CHANGED'].includes(code)) throw Error('HISTORY_SOURCE_MEDIA_ERROR_INVALID');
      if (claim.scopeKey !== historyCaptureScopeKey(scope)) return false;
      return transact(async client => (await client.query(`UPDATE jrc_evolution_origin.history_media SET state='PENDING',lease_token=NULL,lease_until=NULL,
        next_attempt_at=$5::timestamptz+least(300,power(2,least(attempts,8))) * interval '1 second',last_error=$6
        WHERE scope_key=$1 AND run_id=$2 AND reference_id=$3 AND state='CLAIMED' AND lease_token=$4 AND lease_until>$5 RETURNING reference_id`,
      [claim.scopeKey,claim.runId,claim.reference.referenceId,claim.leaseToken,now,code])).rowCount === 1);
    },
  });
}
