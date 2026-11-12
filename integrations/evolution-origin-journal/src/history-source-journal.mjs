import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { historyCaptureScopeKey, historyProjectionDigest, projectHistoryBatch } from './history-projection.mjs';
import { createHistorySourceMedia } from './history-source-media.mjs';

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Private extension of the engine's existing PostgreSQL journal, not a second delivery engine.
 * prepare is synchronous so upstream cannot mutate a batch while the database is unavailable.
 * A source staging receipt never asserts owner confirmation or physical destination custody.
 */
export function createHistorySourceJournal({ pool, encryptionKey, maxStagedBytes, transact, captureMedia = false }) {
  if (!Number.isSafeInteger(maxStagedBytes) || maxStagedBytes < 1 || maxStagedBytes > 128 * 1024 * 1024)
    throw Error('HISTORY_SOURCE_CONFIG_INVALID');
  const key = Buffer.from(encryptionKey), prepared = new Map(), committed = new WeakMap();
  const media = createHistorySourceMedia({ pool, encryptionKey:key, transact });
  let preparedBytes = 0;
  const associated = (scopeKey, captureId, runId, chunkId, hash) => Buffer.from(JSON.stringify(['history-source:2', scopeKey, captureId, runId, chunkId, hash]));
  const seal = (scopeKey, captureId, runId, chunk) => {
    const plaintext = Buffer.from(JSON.stringify(chunk)), hash = historyProjectionDigest(chunk);
    if (plaintext.length > 1048576) throw Error('HISTORY_SOURCE_QUOTA');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(associated(scopeKey, captureId, runId, chunk.chunkId, hash));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    return { scope_key: scopeKey, capture_id: captureId, run_id: runId, chunk_id: chunk.chunkId, ordinal: chunk.ordinal,
      checksum: chunk.checksum, payload_hash: hash, payload_bytes: ciphertext.length, payload_iv: iv, payload_ciphertext: ciphertext, payload_tag: cipher.getAuthTag() };
  };
  const open = row => {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.payload_iv);
      decipher.setAAD(associated(row.scope_key, row.capture_id, row.run_id, row.chunk_id, row.payload_hash));
      decipher.setAuthTag(row.payload_tag);
      const chunk = JSON.parse(Buffer.concat([decipher.update(row.payload_ciphertext), decipher.final()]).toString('utf8'));
      if (historyProjectionDigest(chunk) !== row.payload_hash || historyCaptureScopeKey(chunk.scope) !== row.scope_key
        || chunk.checksum !== historyProjectionDigest(chunk.records)) throw Error();
      return chunk;
    } catch { throw Error('HISTORY_SOURCE_PAYLOAD_UNAVAILABLE'); }
  };
  const journal = {
    claimMedia: media.claimMedia, settleMedia: media.settleMedia, retryMedia: media.retryMedia,
    prepare(scope, runId, events, context) {
      if (!uuid.test(runId)) throw Error('HISTORY_SOURCE_CONTEXT_INVALID');
      const organizationId = scope.organizationId, captureId = context.captureId;
      let bytes = 0;
      const pages = [];
      const captured = captureMedia === true ? media.prepare(scope,runId,captureId,events) : null;
      const projectionContext = captured ? { ...context,mediaReference:request => context.mediaReference?.(request) ?? captured.resolve(request) } : context;
      for (const chunk of projectHistoryBatch(scope, events, projectionContext)) {
        const scopeKey = historyCaptureScopeKey(chunk.scope), page = seal(scopeKey, captureId, runId, chunk);
        bytes += page.payload_bytes;
        if (preparedBytes + bytes > maxStagedBytes) throw Error('HISTORY_SOURCE_QUOTA');
        pages.push(page);
      }
      const mediaSnapshots = captured ? [...captured.snapshots.values()] : [];
      bytes += mediaSnapshots.reduce((sum,item) => sum+item.ciphertext.length,0);
      if (preparedBytes+bytes>maxStagedBytes) throw Error('HISTORY_SOURCE_QUOTA');
      if (!pages.length) throw Error('HISTORY_SOURCE_EVENT_REQUIRED');
      const token = Object.freeze({});
      prepared.set(token, { scopeKey: pages[0].scope_key, organizationId, runId, captureId,
        checksum: historyProjectionDigest([...pages.map(page => page.payload_hash),...mediaSnapshots.map(item=>item.hash)]), bytes, chunkCount: pages.length, released: false, pages,mediaSnapshots });
      preparedBytes += bytes;
      return token;
    },
    async append(token) {
      const value = prepared.get(token) ?? committed.get(token);
      if (!value) throw Error('HISTORY_SOURCE_SNAPSHOT_REQUIRED');
      const receipt = await transact(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`history-source:${value.organizationId}`]);
        const prior = (await client.query(`SELECT run_id,checksum FROM jrc_evolution_origin.history_batches
          WHERE scope_key=$1 AND capture_id=$2`, [value.scopeKey, value.captureId])).rows[0];
        if (prior && (prior.run_id !== value.runId || prior.checksum !== value.checksum)) throw Error('HISTORY_SOURCE_CAPTURE_CONFLICT');
        if (!prior) {
          if (!value.pages) throw Error('HISTORY_SOURCE_SNAPSHOT_UNAVAILABLE');
          const usage = (await client.query(`SELECT (COALESCE(sum(c.payload_bytes),0)+(SELECT COALESCE(sum(m.descriptor_bytes),0)
            FROM jrc_evolution_origin.history_media m JOIN jrc_evolution_origin.history_batches mb USING(scope_key,capture_id)
            WHERE mb.organization_id=$1 AND m.state<>'READY'))::bigint AS bytes
            FROM jrc_evolution_origin.history_chunks c JOIN jrc_evolution_origin.history_batches b USING(scope_key,capture_id)
            WHERE b.organization_id=$1 AND c.state='PENDING'`, [value.organizationId])).rows[0];
          if (Number(usage.bytes) + value.bytes > maxStagedBytes) throw Error('HISTORY_SOURCE_QUOTA');
          await client.query(`INSERT INTO jrc_evolution_origin.history_batches(scope_key,capture_id,organization_id,run_id,checksum)
            VALUES($1,$2,$3,$4,$5)`, [value.scopeKey, value.captureId, value.organizationId, value.runId, value.checksum]);
          const next = Number((await client.query(`SELECT COALESCE(max(ordinal)+1,0)::bigint AS ordinal
            FROM jrc_evolution_origin.history_chunks WHERE scope_key=$1 AND run_id=$2`, [value.scopeKey, value.runId])).rows[0].ordinal);
          let finalBytes = value.mediaSnapshots.reduce((sum,item)=>sum+item.ciphertext.length,0);
          for (const [index, preparedPage] of value.pages.entries()) {
            const ordinal = next + index;
            if (!Number.isSafeInteger(ordinal)) throw Error('HISTORY_SOURCE_QUOTA');
            const page = preparedPage.ordinal === ordinal ? preparedPage
              : seal(value.scopeKey, value.captureId, value.runId, { ...open(preparedPage), ordinal });
            finalBytes += page.payload_bytes;
            if (Number(usage.bytes) + finalBytes > maxStagedBytes) throw Error('HISTORY_SOURCE_QUOTA');
            await client.query(`INSERT INTO jrc_evolution_origin.history_chunks
              (scope_key,capture_id,run_id,chunk_id,ordinal,checksum,payload_hash,payload_bytes,payload_ciphertext,payload_iv,payload_tag)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [value.scopeKey, value.captureId, value.runId, page.chunk_id, page.ordinal,
              page.checksum, page.payload_hash, page.payload_bytes, page.payload_ciphertext, page.payload_iv, page.payload_tag]);
          }
          await media.append(client,value.mediaSnapshots);
        }
        return Object.freeze({ kind: 'STAGED', captureId: value.captureId, chunks: value.chunkCount });
      });
      // Only a real COMMIT releases the in-flight reservation. A failed append
      // retains its sealed snapshot for retry and applies backpressure to arrivals.
      if (!value.released) {
        preparedBytes -= value.bytes;
        for (const page of value.pages) page.payload_ciphertext.fill(0);
        for (const item of value.mediaSnapshots) item.ciphertext.fill(0);
        value.pages = null; value.mediaSnapshots=null; value.released = true;
        prepared.delete(token); committed.set(token,value);
      }
      return receipt;
    },
    /** Retry private appends retained in this live process; not a WhatsApp send or a crash-recovery claim. */
    async retryPrepared({ limit = 1 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw Error('HISTORY_SOURCE_LIMIT_INVALID');
      let count = 0;
      for (const token of [...prepared.keys()].slice(0,limit)) { await journal.append(token); count++; }
      return { staged: count };
    },
    async pending(scope, { limit = 1, runId = null } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('HISTORY_SOURCE_LIMIT_INVALID');
      if (runId !== null && !uuid.test(runId)) throw Error('HISTORY_SOURCE_CONTEXT_INVALID');
      const rows = (await pool.query(`SELECT * FROM jrc_evolution_origin.history_chunks
        WHERE scope_key=$1 AND state='PENDING' AND ($3::uuid IS NULL OR run_id=$3)
        ORDER BY source_sequence LIMIT $2`, [historyCaptureScopeKey(scope), limit, runId])).rows;
      return rows.map(row => freeze({ scopeKey: row.scope_key, runId: row.run_id, captureId: row.capture_id,
        payloadHash: row.payload_hash, chunk: open(row) }));
    },
    async acknowledge(scope, pending, receipt) {
      const current = { protocol: receipt?.protocol, kind: receipt?.kind, durablyAccepted: receipt?.durablyAccepted,
        scopeKey: receipt?.scopeKey, runId: receipt?.runId, chunkId: receipt?.chunkId, checksum: receipt?.checksum, payloadHash: receipt?.payloadHash };
      if (current.protocol !== 'jrc-history-source/2' || !['STAGED', 'VALIDATED'].includes(current.kind) || current.durablyAccepted !== true
        || current.scopeKey !== historyCaptureScopeKey(scope) || current.scopeKey !== pending.scopeKey || current.runId !== pending.runId
        || current.chunkId !== pending.chunk.chunkId || current.checksum !== pending.chunk.checksum
        || current.payloadHash !== pending.payloadHash || current.payloadHash !== historyProjectionDigest(pending.chunk)) return false;
      return transact(async client => (await client.query(`UPDATE jrc_evolution_origin.history_chunks SET state='DELIVERED',acknowledged_at=clock_timestamp()
        WHERE scope_key=$1 AND run_id=$2 AND chunk_id=$3 AND checksum=$4 AND payload_hash=$5 AND state='PENDING' RETURNING chunk_id`,
      [current.scopeKey, current.runId, current.chunkId, current.checksum, current.payloadHash])).rowCount === 1);
    },
  };
  return Object.freeze(journal);
}
