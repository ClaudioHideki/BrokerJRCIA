import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { BinaryMedia } from '@jrc/providers';
import { createMediaStore, registerPendingMedia, type MediaAsset } from '../../src/modules/messaging/media-store.js';
import { createDurablePrivateMediaStore } from '../../src/modules/messaging/durable-private-media.js';
import { createS3PrivateObjectStore, type PrivateObjectStore } from '../../src/modules/messaging/private-object-store.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';

// Candidate fixture only. No test is executed before root releases its PG window.
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const file: BinaryMedia = { bytes: new Uint8Array(Buffer.from('hello')), mimeType: 'application/pdf', kind: 'document', fileName: 'synthetic.pdf' };
let db: Awaited<ReturnType<typeof attendanceDatabase>>;
beforeAll(async () => {
  db = await attendanceDatabase();
});
afterAll(async () => { await db?.dispose(); });

async function registration(t: { org: string; channel: string }, source: 'QR' | 'META' | 'CHATWOOT' = 'META') {
  const descriptor = source === 'META' ? { mediaId: '11111' } : source === 'QR' ? { messageId: 'synthetic-message' }
    : { integrationId: randomUUID(), conversationId: 1, messageId: 2, attachmentId: 3 };
  return db.transact(t.org, tx => registerPendingMedia(tx, t.org, t.channel,
    { source, sourceKey: randomUUID(), kind: 'document', fileName: file.fileName, descriptor }));
}
const media = async (id: string) => (await db.database.pool.query('SELECT * FROM messaging_media WHERE id=$1', [id])).rows[0]!;
const operation = async (id: string) => (await db.database.pool.query('SELECT * FROM media_private_operations WHERE object_id=$1 AND kind=\'PUT\'', [id])).rows[0]!;

function setup(maxStorageBytes = 100) {
  const bytes = new Map<string, Uint8Array>(), actions: string[] = [], downloads: MediaAsset[] = [];
  const binding = createS3PrivateObjectStore({ endpoint: 'https://objects.example.test', bucket: 'broker-private', region: 'us-east-1',
    profile: 'private-v1', accessKeyId: 'SYNTHETICACCESS', secretAccessKey: 'synthetic-only', dedicatedBucket: true });
  const objectStore: PrivateObjectStore = {
    destinationFingerprint: binding.destinationFingerprint,
    async put(ref, body, expected) {
      actions.push('PUT'); expect(createHash('sha256').update(body).digest('hex')).toBe(expected.sha256);
      expect((await operation(ref.operationId)).state).toBe('DISPATCHED'); bytes.set(ref.operationId, new Uint8Array(body)); return { outcome: 'CONFIRMED' };
    },
    async read(ref) { actions.push('GET'); const body = bytes.get(ref.operationId); return body ? { outcome: 'CONFIRMED', bytes: body } : { outcome: 'MISSING' }; },
    async inspect(ref) { actions.push('INSPECT'); const body = bytes.get(ref.operationId); return body
      ? { outcome: 'CONFIRMED', byteLength: body.byteLength, sha256: createHash('sha256').update(body).digest('hex') } : { outcome: 'MISSING' }; },
    async remove() { throw new Error('Cleanup is covered by the separate real lifecycle kernel matrix'); },
  };
  const privateStore = createDurablePrivateMediaStore({ encryptionKey, profile: 'private-v1', objectStore, maxStorageBytes,
    requestTimeoutMs: 1_000, transact: db.transact, cleanupTransact: async () => { throw new Error('No lifecycle action in the facade'); } });
  const download = async (asset: MediaAsset) => { downloads.push(asset); return file; };
  function facade(enabled = true, privatePort = privateStore) {
    const options = { encryptionKey, maxStorageBytes, transact: db.transact, download, ...(enabled ? { privateStore: privatePort } : {}) };
    return createMediaStore(options as Parameters<typeof createMediaStore>[0]);
  }
  return { objectStore, privateStore, facade, bytes, actions, downloads };
}

it('preserves the existing inline facade read/runOnce/retry API without a private store', async () => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t), h = setup(), store = h.facade(false);
  expect(await store.runOnce(t.org)).toBeUndefined();
  expect(await media(id)).toMatchObject({ storage_backend: 'INLINE_V1', status: 'READY', private_object_id: null });
  expect(await store.read(t.org, id)).toEqual(file); expect(h.actions).toEqual([]); expect(h.downloads).toHaveLength(1);
  const failed = await registration(t); await db.database.pool.query("UPDATE messaging_media SET status='FAILED',last_error='MEDIA_DOWNLOAD_FAILED' WHERE id=$1", [failed]);
  await store.retry(t.org, failed); expect((await media(failed)).status).toBe('PENDING');
});

it('preserves registration deduplication and strict source descriptors', async () => {
  const t = await seedAttendanceTenant(db.database, false), sourceKey = randomUUID();
  const input = { source: 'META' as const, sourceKey, kind: 'document' as const, fileName: file.fileName, descriptor: { mediaId: '11111' } };
  const first = await db.transact(t.org, tx => registerPendingMedia(tx, t.org, t.channel, input));
  expect(await db.transact(t.org, tx => registerPendingMedia(tx, t.org, t.channel, input))).toBe(first);
  await expect(db.transact(t.org, tx => registerPendingMedia(tx, t.org, t.channel, { ...input, sourceKey: randomUUID(), descriptor: { mediaId: '11111', url: 'https://untrusted.example.test' } }))).rejects.toThrow();
});

it.each(['QR', 'META', 'CHATWOOT'] as const)('composes %s download with the current lease, private stage/PUT/read and unchanged void runOnce', async source => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t, source), h = setup(), store = h.facade();
  expect(await store.runOnce(t.org)).toBeUndefined();
  const row = await media(id);
  expect(row).toMatchObject({ source, storage_backend: 'PRIVATE_OBJECT', status: 'READY', encrypted_data: null, byte_size: 5, lease_token: null });
  expect(await store.read(t.org, id)).toEqual(file);
  expect(h.downloads).toHaveLength(1); expect(h.downloads[0]!.lease_token).toMatch(/^[a-f0-9-]{36}$/);
  expect(h.actions).toEqual(['PUT', 'GET']);
});

it('reconciles a private UNKNOWN after restart without downloading or putting it again', async () => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t), h = setup(), store = h.facade();
  h.objectStore.put = async (ref, body) => { h.actions.push('PUT'); h.bytes.set(ref.operationId, new Uint8Array(body)); return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; };
  await store.runOnce(t.org); const first = await media(id);
  expect(first).toMatchObject({ storage_backend: 'PRIVATE_OBJECT', status: 'STORING' });
  await h.facade().runOnce(t.org); await h.facade().retry(t.org, id);
  expect((await media(id)).status).toBe('READY'); expect(h.downloads).toHaveLength(1); expect(h.actions).toEqual(['PUT', 'INSPECT']);
});

it('never reopens STORING UNKNOWN or rejected private storage as a PENDING download on retry', async () => {
  const t = await seedAttendanceTenant(db.database, false), a = await registration(t), b = await registration(t), h = setup(), store = h.facade();
  h.objectStore.put = async () => ({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  await store.runOnce(t.org); await store.retry(t.org, a); expect((await media(a)).status).toBe('STORING');
  h.objectStore.put = async () => ({ outcome: 'REJECTED', code: 'OBJECT_ACCESS_DENIED' });
  await store.runOnce(t.org); const rejected = await media(b);
  expect(rejected).toMatchObject({ status: 'FAILED', storage_backend: 'PRIVATE_OBJECT' });
  await store.retry(t.org, b); expect((await media(b)).status).toBe('FAILED'); expect(h.downloads).toHaveLength(2);
});

it('gives private UNKNOWN inspection and a separate PENDING download progress in the same tick', async () => {
  const t = await seedAttendanceTenant(db.database, false), a = await registration(t), h = setup(), store = h.facade();
  h.objectStore.put = async () => { h.actions.push('UNKNOWN_PUT'); return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; };
  await store.runOnce(t.org); const b = await registration(t);
  h.objectStore.put = async (ref, body) => { h.actions.push('PUT'); h.bytes.set(ref.operationId, new Uint8Array(body)); return { outcome: 'CONFIRMED' }; };
  await store.runOnce(t.org);
  expect((await media(a)).status).toBe('STORING'); expect((await media(b)).status).toBe('READY');
  expect(h.actions).toEqual(['UNKNOWN_PUT', 'INSPECT', 'PUT']); expect(h.downloads).toHaveLength(2);
});

it('counts existing inline bytes and unknown private reservations exactly once for mixed quota', async () => {
  const t = await seedAttendanceTenant(db.database, false), inline = await registration(t), h = setup(11);
  await h.facade(false).runOnce(t.org); expect((await media(inline)).storage_backend).toBe('INLINE_V1');
  const uncertain = await registration(t); h.objectStore.put = async () => ({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  await h.facade().runOnce(t.org); expect((await media(uncertain)).status).toBe('STORING');
  const overflow = await registration(t); await h.facade().runOnce(t.org);
  expect(await media(overflow)).toMatchObject({ status: 'FAILED', last_error: 'MEDIA_STORAGE_LIMIT', private_object_id: null });
  expect((await db.database.pool.query('SELECT sum(reserved_bytes)::integer AS bytes FROM media_private_objects WHERE organization_id=$1', [t.org])).rows).toEqual([{ bytes: 5 }]);
});

it('does not let an expired downloader lease stage or replace the current claim', async () => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t), h = setup();
  const replacement = randomUUID();
  const options = { encryptionKey, transact: db.transact, maxStorageBytes: 100, privateStore: h.privateStore,
    download: async () => { await db.database.pool.query("UPDATE messaging_media SET lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [id, replacement]); return file; } };
  await createMediaStore(options as Parameters<typeof createMediaStore>[0]).runOnce(t.org);
  expect(await media(id)).toMatchObject({ status: 'DOWNLOADING', lease_token: replacement, private_object_id: null });
  expect(h.actions).toEqual([]);
});

it('protects private FAILED rows from retry even when the private driver is not configured', async () => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t), h = setup();
  const staged = await h.privateStore.stage(t.org, id, file);
  h.objectStore.put = async () => ({ outcome: 'REJECTED', code: 'OBJECT_ACCESS_DENIED' });
  await h.privateStore.dispatchPut(t.org, staged.objectId);
  await h.facade(false).retry(t.org, id);
  expect(await media(id)).toMatchObject({ status: 'FAILED', storage_backend: 'PRIVATE_OBJECT', private_object_id: staged.objectId });
  expect(h.downloads).toEqual([]);
});

it('reports an unavailable private backend without falling back to inline decryption', async () => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t), h = setup();
  const staged = await h.privateStore.stage(t.org, id, file); await h.privateStore.dispatchPut(t.org, staged.objectId);
  await expect(h.facade(false).read(t.org, id)).rejects.toMatchObject({ code: 'MEDIA_OBJECT_BACKEND_UNAVAILABLE' });
  expect(h.actions).toEqual(['PUT']);
});

it('excludes released private reservations from inline admission while preserving the private history', async () => {
  const t = await seedAttendanceTenant(db.database, false), old = await registration(t), h = setup(6);
  const staged = await h.privateStore.stage(t.org, old, file);
  h.objectStore.put = async () => ({ outcome: 'REJECTED', code: 'OBJECT_ACCESS_DENIED' });
  await h.privateStore.dispatchPut(t.org, staged.objectId);
  const next = await registration(t); await h.facade(false).runOnce(t.org);
  expect(await media(next)).toMatchObject({ status: 'READY', storage_backend: 'INLINE_V1' });
  expect(await media(old)).toMatchObject({ status: 'FAILED', storage_backend: 'PRIVATE_OBJECT', private_object_id: staged.objectId });
});

it('continues factual private inspection during suspension without claiming a new pending download', async () => {
  const t = await seedAttendanceTenant(db.database, false), old = await registration(t), h = setup();
  h.objectStore.put = async () => ({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  const staged = await h.privateStore.stage(t.org, old, file); await h.privateStore.dispatchPut(t.org, staged.objectId);
  const next = await registration(t);
  await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [t.org]);
  await h.facade().runOnce(t.org);
  expect(h.actions).toEqual(['INSPECT']); expect(h.downloads).toEqual([]);
  expect((await media(old)).status).toBe('STORING'); expect((await media(next)).status).toBe('PENDING');
});

it('forwards trusted authorization to both sides of a private GET before returning plaintext', async () => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t), h = setup();
  const staged = await h.privateStore.stage(t.org, id, file); await h.privateStore.dispatchPut(t.org, staged.objectId);
  let checks = 0; const store = h.facade();
  await expect(Reflect.apply(store.read, store, [t.org, id, { authorize: async () => {
    if (++checks === 2) throw new Error('SYNTHETIC_READ_REVOKED');
  } }])).rejects.toThrow('SYNTHETIC_READ_REVOKED');
  expect(checks).toBe(2); expect(h.actions).toEqual(['PUT', 'GET']);
});

it('recovers a lost stage commit receipt without resetting storage or downloading the bytes again', async () => {
  const t = await seedAttendanceTenant(db.database, false), id = await registration(t), h = setup();
  const losingPort = { ...h.privateStore, stage: async (...args: Parameters<typeof h.privateStore.stage>) => {
    await h.privateStore.stage(...args); throw new Error('SYNTHETIC_STAGE_COMMIT_RECEIPT_LOST');
  } };
  await h.facade(true, losingPort).runOnce(t.org);
  expect((await media(id)).status).toBe('STORING'); expect(h.actions).toEqual([]);
  await h.facade().runOnce(t.org);
  expect((await media(id)).status).toBe('READY'); expect(h.downloads).toHaveLength(1); expect(h.actions).toEqual(['PUT']);
});
