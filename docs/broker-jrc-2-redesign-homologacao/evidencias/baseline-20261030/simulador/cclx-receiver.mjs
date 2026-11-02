import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, realpath, lstat, readdir, open, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const LAB_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000900';
export const LAB_ORGANIZATIONS = Object.freeze([LAB_ORGANIZATION_ID, '00000000-0000-4000-8000-000000000910']);
export const LAB_SECRET = 'synthetic-cclx-fixture-key-never-production';
const MARKER = 'CCLX_SYNTHETIC_ONLY_V1';
const APP_ID = 1128483928;
const EVENT_ID = /^00000000-0000-4000-8000-\d{12}$/;
const MEDIA_FILE = /^media-[a-f0-9]{64}(?:-[a-f0-9-]{36}\.part|\.bin)$/;
const FAULTS = new Set(['http500', 'timeoutBeforeCommit', 'rollbackBeforeCommit', 'lostAckAfterCommit']);

export function requireLabOnly(options = {}) {
  if (process.env.NODE_ENV === 'production' || options.environment === 'production') throw new Error('PRODUCTION_REFUSED');
  if (options.labOnly !== true) throw new Error('LAB_ONLY_REQUIRED');
}

export async function createLabState(options) {
  requireLabOnly(options);
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'cclx-lab-'));
  const token = randomUUID();
  await writeFile(join(directory, 'state.json'), JSON.stringify({ kind: MARKER, token }), { flag: 'wx', mode: 0o600 });
  return Object.freeze({ directory, token });
}

async function validateState(state) {
  try {
    const directory = await realpath(state.directory);
    if (resolve(state.directory) !== directory || dirname(directory) !== await realpath(tmpdir()) ||
        !/^cclx-lab-[A-Za-z0-9]+$/.test(basename(directory)) || (await lstat(state.directory)).isSymbolicLink()) throw new Error();
    const entries = await readdir(directory);
    for (const name of entries) {
      if ((!['state.json', 'inbox.sqlite', 'inbox.sqlite-wal', 'inbox.sqlite-shm'].includes(name) && !MEDIA_FILE.test(name)) ||
          !(await lstat(join(directory, name))).isFile() || (await lstat(join(directory, name))).isSymbolicLink()) throw new Error();
    }
    const marker = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    if (marker.kind !== MARKER || marker.token !== state.token || typeof state.token !== 'string') throw new Error();
    return { directory, existing: entries.includes('inbox.sqlite') };
  } catch { throw new Error('INVALID_LAB_STATE'); }
}

const hash = value => createHash('sha256').update(value).digest('hex');
const send = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};
const fail = (status, code) => Object.assign(new Error(code), { status });

function isStrictIsoUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
}

function validateEnvelope(raw, headers, replayWindowSeconds) {
  const id = headers['x-jrc-event-id'], timestamp = headers['x-jrc-timestamp'], signature = headers['x-jrc-signature'];
  if (typeof id !== 'string' || !EVENT_ID.test(id) || typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) ||
      Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > replayWindowSeconds ||
      typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw fail(401, 'AUTHENTICATION_REFUSED');
  const expected = createHmac('sha256', LAB_SECRET).update(`${timestamp}.${id}.`).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) throw fail(401, 'AUTHENTICATION_REFUSED');
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); } catch { throw fail(400, 'INVALID_JSON'); }
  if (!LAB_ORGANIZATIONS.includes(envelope?.organizationId)) throw fail(403, 'TENANT_REFUSED');
  if (envelope.eventId !== id) throw fail(400, 'EVENT_ID_MISMATCH');
  const keys = ['schemaVersion', 'eventId', 'cursor', 'organizationId', 'type', 'occurredAt', 'data'];
  if (Object.keys(envelope).some(key => !keys.includes(key)) || envelope.schemaVersion !== 1 ||
      envelope.type !== 'message.received' || typeof envelope.cursor !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(envelope.cursor) ||
      BigInt(envelope.cursor) > 9223372036854775807n ||
      !isStrictIsoUtc(envelope.occurredAt) ||
      envelope.data?.labFixture !== true || !Number.isSafeInteger(envelope.data.sequence) || envelope.data.sequence < 0 ||
      Object.keys(envelope.data).some(key => !['labFixture', 'sequence'].includes(key))) throw fail(400, 'SYNTHETIC_FIXTURE_REQUIRED');
  return envelope;
}

/** LAB route only: /lab/cclx/events is deliberately not a Broker endpoint. */
export async function openLabReceiver(options = {}) {
  requireLabOnly(options);
  if (options.host !== undefined && options.host !== '127.0.0.1') throw new Error('LOOPBACK_ONLY');
  const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
  const replayWindowSeconds = options.replayWindowSeconds ?? 300;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 2 * 1024 * 1024 ||
      !Number.isSafeInteger(replayWindowSeconds) || replayWindowSeconds < 1 || replayWindowSeconds > 300) throw new Error('INVALID_LIMIT');
  const faults = [...(options.faults ?? [])];
  if (faults.some(fault => !FAULTS.has(fault))) throw new Error('INVALID_FAULT');
  const { directory, existing } = await validateState(options.state);
  const db = new DatabaseSync(join(directory, 'inbox.sqlite'));
  try {
    if (existing && db.prepare('PRAGMA application_id').get().application_id !== APP_ID) throw new Error('INVALID_LAB_DATABASE');
    if (existing && db.prepare('PRAGMA user_version').get().user_version !== 3) throw new Error('LAB_STATE_SCHEMA_OUTDATED_CREATE_FRESH_STATE');
    db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS inbox (organization_id TEXT NOT NULL, event_id TEXT NOT NULL, body_hash TEXT NOT NULL,
        committed_at TEXT NOT NULL, envelope_json TEXT NOT NULL, PRIMARY KEY(organization_id,event_id));
      CREATE TABLE IF NOT EXISTS projections (organization_id TEXT NOT NULL,event_id TEXT NOT NULL,
        PRIMARY KEY(organization_id,event_id));
      CREATE TABLE IF NOT EXISTS media_receipts (organization_id TEXT NOT NULL,event_id TEXT NOT NULL,receipt_json TEXT NOT NULL,
        PRIMARY KEY(organization_id,event_id), FOREIGN KEY(organization_id,event_id) REFERENCES inbox(organization_id,event_id));
      PRAGMA user_version=3;`);
  } catch (error) { db.close(); throw error; }
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/lab/cclx/events') { req.resume(); return send(res, 404, { code: 'LAB_ROUTE_ONLY' }); }
    if (req.headers['content-type'] !== 'application/json') { req.resume(); return send(res, 415, { code: 'JSON_REQUIRED' }); }
    let length = 0, chunks = [], tooLarge = false;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > maxBodyBytes) { tooLarge = true; chunks = []; }
      else if (!tooLarge) chunks.push(chunk);
    });
    req.on('error', () => { /* client abort is an expected local fault */ });
    req.on('end', () => {
      try {
        if (tooLarge) throw fail(413, 'BODY_LIMIT');
        const raw = Buffer.concat(chunks), envelope = validateEnvelope(raw, req.headers, replayWindowSeconds);
        const fault = faults.shift();
        if (fault === 'http500') throw fail(500, 'SYNTHETIC_HTTP500');
        if (fault === 'timeoutBeforeCommit') return;
        const bodyHash = hash(raw);
        let duplicate = false;
        db.exec('BEGIN IMMEDIATE');
        try {
          const previous = db.prepare('SELECT body_hash FROM inbox WHERE organization_id=? AND event_id=?').get(envelope.organizationId, envelope.eventId);
          if (previous) {
            if (previous.body_hash !== bodyHash) throw fail(409, 'EVENT_CONTENT_CONFLICT');
            duplicate = true;
          } else {
            db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?)').run(envelope.organizationId, envelope.eventId, bodyHash,
              new Date().toISOString(), JSON.stringify(envelope));
            db.prepare('INSERT INTO projections VALUES(?,?)').run(envelope.organizationId, envelope.eventId);
          }
          if (fault === 'rollbackBeforeCommit') throw fail(500, 'SYNTHETIC_ROLLBACK');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        if (fault === 'lostAckAfterCommit') { res.destroy(); return; }
        send(res, 202, { status: 'accepted', duplicate });
      } catch (error) { send(res, error.status ?? 500, { code: error.status ? error.message : 'LAB_INTERNAL_ERROR' }); }
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  } catch (error) { db.close(); throw error; }
  let closed = false;
  let mediaQueue = Promise.resolve();
  const validateIdentity = (eventId, organizationId) => {
    if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new Error('SYNTHETIC_EVENT_ID_REQUIRED');
    if (!LAB_ORGANIZATIONS.includes(organizationId)) throw new Error('TENANT_REFUSED');
  };
  const readMediaReceipt = (eventId, organizationId = LAB_ORGANIZATION_ID) => {
    validateIdentity(eventId, organizationId);
    const row = db.prepare('SELECT receipt_json FROM media_receipts WHERE organization_id=? AND event_id=?').get(organizationId, eventId);
    return row ? JSON.parse(row.receipt_json) : null;
  };
  const persistMedia = async input => {
    requireLabOnly({ labOnly: true });
    const { eventId, organizationId, expectedHash, mime, maxBytes, chunks, fault } = input;
    validateIdentity(eventId, organizationId);
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 ||
        !['image/png', 'audio/wav', 'video/mp4', 'application/pdf'].includes(mime) ||
        (fault !== undefined && !['afterFileSync', 'afterReceiptCommit'].includes(fault))) throw new Error('INVALID_MEDIA_FIXTURE');
    if (!db.prepare('SELECT 1 FROM inbox WHERE organization_id=? AND event_id=?').get(organizationId, eventId)) throw new Error('EVENT_NOT_PERSISTED');
    const previous = readMediaReceipt(eventId, organizationId);
    if (previous && (previous.hash !== expectedHash || previous.mime !== mime)) throw new Error('MEDIA_CONTENT_CONFLICT');
    // Generated names only. No caller-controlled path, URL or external storage is accepted.
    const objectName = `media-${expectedHash}.bin`, finalPath = join(directory, objectName);
    const temporary = join(directory, `media-${expectedHash}-${randomUUID()}.part`);
    let handle, total = 0;
    const digest = createHash('sha256'), signature = [];
    try {
      handle = await open(temporary, 'wx', 0o600);
      for await (const chunk of chunks) {
        if (!Buffer.isBuffer(chunk)) throw new Error('INVALID_MEDIA_CHUNK');
        total += chunk.length;
        if (total > maxBytes) throw new Error('LIMIT_EXCEEDED');
        digest.update(chunk);
        if (signature.reduce((n, part) => n + part.length, 0) < 16) signature.push(chunk.subarray(0, 16));
        await handle.writeFile(chunk);
      }
      if (digest.digest('hex') !== expectedHash) throw new Error('HASH_MISMATCH');
      if (sniffMime(Buffer.concat(signature)) !== mime) throw new Error('MIME_REJECTED');
      await handle.sync(); await handle.close(); handle = undefined;
      let present;
      try { present = await lstat(finalPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (present) {
        if (!present.isFile() || present.isSymbolicLink() || hash(await readFile(finalPath)) !== expectedHash) throw new Error('STORED_MEDIA_CORRUPTED');
        await unlink(temporary);
      } else await rename(temporary, finalPath);
      if (fault === 'afterFileSync') throw new Error('SYNTHETIC_AFTER_FILE_SYNC');
      if (previous) return previous;
      const receipt = { status: 'COPY_PERSISTED_UNVALIDATED', ack: 'ACK_COPY_PERSISTED_LAB', organizationId, eventId,
        objectName, bytes: total, mime, hash: expectedHash, committedAt: new Date().toISOString(),
        sourceEligibleForDeletion: false, validation: 'SIGNATURE_ONLY_NO_CODEC_VALIDATION' };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO media_receipts VALUES(?,?,?)').run(organizationId, eventId, JSON.stringify(receipt));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      if (fault === 'afterReceiptCommit') throw new Error('SYNTHETIC_LOST_MEDIA_ACK');
      return receipt;
    } finally {
      await handle?.close();
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  return {
    url: `http://127.0.0.1:${server.address().port}/lab/cclx/events`,
    stats: () => ({ inbox: db.prepare('SELECT count(*) AS n FROM inbox').get().n,
      projections: db.prepare('SELECT count(*) AS n FROM projections').get().n }),
    // Local inspection only, not an HTTP endpoint. Read back the validated synthetic envelope after restart.
    readEvent: (id, organizationId = LAB_ORGANIZATION_ID) => {
      validateIdentity(id, organizationId);
      const row = db.prepare('SELECT envelope_json FROM inbox WHERE organization_id=? AND event_id=?').get(organizationId, id);
      return row ? JSON.parse(row.envelope_json) : null;
    },
    readMediaReceipt,
    persistMedia: input => {
      if (closed) return Promise.reject(new Error('LAB_RECEIVER_CLOSED'));
      const operation = mediaQueue.then(() => persistMedia(input));
      mediaQueue = operation.catch(() => {});
      return operation;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
      await mediaQueue;
      db.close();
    },
  };
}

function sniffMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Injected synthetic byte transport: signature sniffing does NOT validate codecs. Never deletes a source. */
export async function copySyntheticMedia(options = {}) {
  requireLabOnly(options);
  if (!Buffer.isBuffer(options.expected) || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 2 * 1024 * 1024)
    throw new Error('INVALID_MEDIA_FIXTURE');
  let bytes = 0;
  const chunks = [];
  const result = status => ({ status, bytes, hashMatches: false, sourceEligibleForDeletion: false });
  try {
    for await (const chunk of options.chunks) {
      if (!Buffer.isBuffer(chunk)) throw new Error('INVALID_MEDIA_CHUNK');
      bytes += chunk.length;
      if (bytes > options.maxBytes) return result('LIMIT_EXCEEDED');
      chunks.push(Buffer.from(chunk));
    }
  } catch { return result('INTERRUPTED'); }
  const copied = Buffer.concat(chunks);
  if (sniffMime(copied) !== options.mime) return result('MIME_REJECTED');
  if (hash(copied) !== hash(options.expected)) return result('HASH_MISMATCH');
  return { ...result('COPIED_UNVALIDATED'), hashMatches: true, hash: hash(copied), validation: 'SIGNATURE_ONLY_NO_CODEC_VALIDATION' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--lab-only') throw new Error('LAB_ONLY_REQUIRED');
    requireLabOnly({ labOnly: true });
    const state = await createLabState({ labOnly: true });
    const receiver = await openLabReceiver({ labOnly: true, state });
    console.log(JSON.stringify({ kind: MARKER, url: receiver.url, stateDirectory: state.directory,
      note: 'LAB route only; fresh synthetic temporary state; no Broker/provider connection' }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await receiver.close(); process.exitCode = 0; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
