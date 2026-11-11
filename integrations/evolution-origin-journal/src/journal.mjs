import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalText } from './projection.mjs';
import { createHistorySourceJournal } from './history-source-journal.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function normalizedBinding(value) {
  if (!value || !['instanceId', 'instanceName', 'destinationId'].every(name => typeof value[name] === 'string' && value[name].length > 0 && value[name].length <= 255)
    || !integer(value.generation, 1, 2147483647) || !integer(value.revision, 1, 2147483647)) throw new Error('ORIGIN_BINDING_INVALID');
  return { instanceId: value.instanceId, instanceName: value.instanceName, generation: value.generation, destinationId: value.destinationId, revision: value.revision };
}
export function bindingFingerprint(binding) { return hash(JSON.stringify(normalizedBinding(binding))); }
function scopeKey(binding) { const b = normalizedBinding(binding); return hash(JSON.stringify([b.instanceId, b.generation, b.destinationId, b.revision])); }
async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL synchronous_commit = on');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
export async function installOriginJournal(pool) { await pool.query(await readFile(new URL('../schema/origin-journal.sql', import.meta.url), 'utf8')); }

/** Engine-owned obligation store. The caller supplies its own pool/key; no defaults or auto-start. */
export function createOriginJournal({ pool, encryptionKey, history }) {
  if (!pool || !Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw new Error('ORIGIN_JOURNAL_CONFIGURATION_INVALID');
  const key = Buffer.from(encryptionKey);
  function encrypt(body, associated) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associated));
    return { iv, ciphertext: Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]), tag: cipher.getAuthTag() };
  }
  function decrypt(row, binding) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.payload_iv);
      decipher.setAAD(Buffer.from(`${row.id}:${row.scope_key}:${row.binding_fingerprint}`));
      decipher.setAuthTag(row.payload_tag);
      const body = JSON.parse(Buffer.concat([decipher.update(row.payload_ciphertext), decipher.final()]).toString('utf8'));
      return canonicalText(binding, body);
    } catch { throw new Error('ORIGIN_PAYLOAD_UNAVAILABLE'); }
  }
  return Object.freeze({
    history: history ? createHistorySourceJournal({ pool, encryptionKey: key, maxStagedBytes: history.maxStagedBytes,
      transact: work => transaction(pool, work) }) : null,
    async lookupCommittedOwnership(binding, envelope) {
      const body = canonicalText(binding, envelope), scope = scopeKey(binding);
      const eventKey = hash(JSON.stringify([body.data.key.id, body.data.key.fromMe, body.data.key.remoteJid]));
      // Dedicated pool read, outside the append transaction: MVCC cannot see its uncommitted row.
      const row = (await pool.query('SELECT id,scope_key,event_key,binding_fingerprint,body_hash FROM jrc_evolution_origin.events WHERE scope_key=$1 AND event_key=$2', [scope, eventKey])).rows[0];
      return row ? Object.freeze({ id: row.id, scopeKey: row.scope_key, eventKey: row.event_key, bindingFingerprint: row.binding_fingerprint, bodyHash: row.body_hash }) : null;
    },
    async acceptBatch(binding, envelopes) {
      const scope = scopeKey(binding), fingerprint = bindingFingerprint(binding);
      if (!Array.isArray(envelopes) || envelopes.length > 100) throw new Error('ORIGIN_TEXT_INVALID');
      const bodies = envelopes.map(envelope => canonicalText(binding, envelope));
      if (!bodies.length) return [];
      return transaction(pool, async client => {
        const accepted = [];
        for (const body of bodies) {
          const eventKey = hash(JSON.stringify([body.data.key.id, body.data.key.fromMe, body.data.key.remoteJid]));
          const bodyHash = hash(JSON.stringify(body)), id = randomUUID();
          const encrypted = encrypt(body, `${id}:${scope}:${fingerprint}`);
          const inserted = await client.query(`INSERT INTO jrc_evolution_origin.events
            (id,scope_key,event_key,binding_fingerprint,body_hash,payload_ciphertext,payload_iv,payload_tag,key_version)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,1) ON CONFLICT(scope_key,event_key) DO NOTHING RETURNING id,body_hash`,
          [id, scope, eventKey, fingerprint, bodyHash, encrypted.ciphertext, encrypted.iv, encrypted.tag]);
          const row = inserted.rows[0] ?? (await client.query('SELECT id,body_hash FROM jrc_evolution_origin.events WHERE scope_key=$1 AND event_key=$2', [scope, eventKey])).rows[0];
          if (!row || row.body_hash !== bodyHash) throw new Error('ORIGIN_EVENT_CONFLICT');
          accepted.push({ id: row.id, scopeKey: scope });
        }
        return accepted;
      });
    },
    async claim(binding, { leaseMs = 30000 } = {}) {
      const scope = scopeKey(binding), fingerprint = bindingFingerprint(binding);
      if (!integer(leaseMs, 100, 300000)) throw new Error('ORIGIN_LEASE_INVALID');
      return transaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope]);
        const row = (await client.query(`SELECT *,lease_until>clock_timestamp() AS lease_active,next_attempt_at>clock_timestamp() AS not_due
          FROM jrc_evolution_origin.events WHERE scope_key=$1 AND state<>'DELIVERED' ORDER BY source_sequence LIMIT 1 FOR UPDATE`, [scope])).rows[0];
        if (!row || row.state === 'BLOCKED' || row.lease_active || row.not_due) return null;
        if (row.binding_fingerprint !== fingerprint) throw new Error('ORIGIN_BINDING_CHANGED');
        const body = decrypt(row, binding), token = randomUUID();
        if (row.lease_token) await client.query(`UPDATE jrc_evolution_origin.attempts SET outcome='LEASE_EXPIRED',category='LEASE_EXPIRED',finished_at=clock_timestamp() WHERE lease_token=$1 AND outcome='CLAIMED'`, [row.lease_token]);
        const updated = (await client.query(`UPDATE jrc_evolution_origin.events SET state='CLAIMED',attempt_count=attempt_count+1,
          lease_token=$2,lease_until=clock_timestamp()+($3*interval '1 millisecond'),updated_at=clock_timestamp() WHERE id=$1 RETURNING attempt_count`, [row.id, token, leaseMs])).rows[0];
        await client.query('INSERT INTO jrc_evolution_origin.attempts(id,event_id,number,lease_token) VALUES($1,$2,$3,$4)', [randomUUID(), row.id, updated.attempt_count, token]);
        return { id: row.id, scopeKey: scope, bindingFingerprint: fingerprint, leaseToken: token, attempt: updated.attempt_count, body };
      });
    },
    async finish(claim, { type, category, httpStatus = null, durationMs = 0, retryAfterMs = 0 }) {
      if (!['DELIVERED', 'RETRY', 'BLOCKED'].includes(type) || typeof category !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(category)
        || !integer(durationMs, 0, 2147483647) || !integer(retryAfterMs, 0, 300000) || !(httpStatus === null || integer(httpStatus, 100, 599))) throw new Error('ORIGIN_OUTCOME_INVALID');
      return transaction(pool, async client => {
        const settled = await client.query(`UPDATE jrc_evolution_origin.events SET state=$4,lease_token=NULL,lease_until=NULL,
          last_category=$5,last_http_status=$6,next_attempt_at=clock_timestamp()+($7*interval '1 millisecond'),updated_at=clock_timestamp()
          WHERE id=$1 AND scope_key=$2 AND lease_token=$3 AND state='CLAIMED' AND lease_until>clock_timestamp() RETURNING id`,
        [claim.id, claim.scopeKey, claim.leaseToken, type === 'RETRY' ? 'PENDING' : type, category, httpStatus, retryAfterMs]);
        if (!settled.rowCount) return false;
        await client.query(`UPDATE jrc_evolution_origin.attempts SET outcome=$2,category=$3,http_status=$4,duration_ms=$5,finished_at=clock_timestamp() WHERE lease_token=$1 AND outcome='CLAIMED'`, [claim.leaseToken, type, category, httpStatus, durationMs]);
        return true;
      });
    },
  });
}
