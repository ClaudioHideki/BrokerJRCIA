import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { BinaryMedia } from '@jrc/providers';
import { createMediaStore, registerPendingMedia, type MediaAsset } from '../../src/modules/messaging/media-store.js';
import { createMediaStore as createLegacyMediaStore, registerPendingMedia as registerLegacyPendingMedia } from '../../src/modules/messaging/media-store.js';
import { createDurablePrivateMediaStore } from '../../src/modules/messaging/durable-private-media.js';
import { createS3PrivateObjectStore, type PrivateObjectStore, type PrivateObjectRef, privateObjectKey } from '../../src/modules/messaging/private-object-store.js';
import { withLifecycleWorkerTransaction } from '../../src/modules/lifecycle/service.js';
import { attendanceDatabase, seedAttendanceTenant } from '../integration/helpers/attendance.js';
import { requireTestDatabaseAdminUrl } from '../integration/helpers/postgres.js';
import { withGlobalRoleLock } from '../integration/helpers/global-role-lock.js';

import { requireStorageEnvironment } from './environment.js';
// Explicit storage profile only; missing configuration is a failing gate.
const storage = requireStorageEnvironment();
const { endpoint, bucket, profile, region } = storage;
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const file: BinaryMedia = { bytes: new Uint8Array(Buffer.from('hello')), mimeType: 'application/pdf', kind: 'document', fileName: 'synthetic.pdf' };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const control = () => ({ deadline: new Date(Date.now() + 5_000) });
const credentials = { access: storage.access, secret: storage.secret };
let db: Awaited<ReturnType<typeof attendanceDatabase>>;
let lifecycle: Pool, platform: Pool, platformActor: string;
let historical: { tenant: Awaited<ReturnType<typeof tenant>>; id: string; row: Record<string, unknown> };

function adapter(transport?: typeof fetch, destination = bucket) {
  return createS3PrivateObjectStore({ endpoint, bucket: destination, profile, region,
    accessKeyId: credentials.access, secretAccessKey: credentials.secret, dedicatedBucket: true,
    allowLoopbackHttpForTests: true, requestTimeoutMs: 5_000, ...(transport ? { fetch: transport } : {}) });
}
function rolePool(role: string) {
  const url = new URL(db.database.connectionString); url.username = role; url.password = '';
  return new Pool({ connectionString: url.href, max: 1 });
}
async function tenant() {
  const t = await seedAttendanceTenant(db.database, false), instance = randomUUID();
  const provider = (await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1', [t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE id=$1", [provider]);
  await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Synthetic MinIO media',$4,'CONNECTED')", [instance, t.org, provider, `synthetic-${instance}`]);
  await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$2,phone_number_id=NULL,waba_id=NULL WHERE id=$1", [t.channel, instance]);
  const actor = (await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'", [t.org])).rows[0]!.user_id as string;
  return { ...t, instance, actor };
}
async function pending(t: { org: string; channel: string }) {
  return db.transact(t.org, tx => registerPendingMedia(tx, t.org, t.channel, {
    source: 'META', sourceKey: randomUUID(), kind: 'document', fileName: file.fileName, descriptor: { mediaId: '11111' },
  }));
}
const media = async (id: string) => (await db.database.pool.query('SELECT * FROM messaging_media WHERE id=$1', [id])).rows[0]!;
const object = async (id: string) => (await db.database.pool.query('SELECT * FROM media_private_objects WHERE id=$1', [id])).rows[0]!;
const operation = async (id: string, kind = 'PUT') => (await db.database.pool.query('SELECT * FROM media_private_operations WHERE object_id=$1 AND kind=$2', [id, kind])).rows[0]!;

function setup(maxStorageBytes = 100) {
  const http: { method: string; status: number }[] = [], downloads: MediaAsset[] = [];
  let losePutReceipt = false, loseDeleteInspection = false, afterRead: (() => Promise<void>) | undefined;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const response = await fetch(input, init);
    if (url.pathname.endsWith('.cipher')) http.push({ method, status: response.status });
    return response;
  };
  const real = adapter(transport);
  const objectStore: PrivateObjectStore = {
    destinationFingerprint: real.destinationFingerprint,
    async put(ref, bytes, expected, input) {
      expect(await operation(ref.operationId)).toMatchObject({ state: 'DISPATCHED' });
      const result = await real.put(ref, bytes, expected, input);
      // Deliberately lose only the verified PUT receipt; MinIO I/O stays real.
      return losePutReceipt && result.outcome === 'CONFIRMED' ? { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' } : result;
    },
    async read(ref, expected, input) { const result = await real.read(ref, expected, input); await afterRead?.(); return result; },
    async inspect(ref, expected, input) {
      // A DELETE ACK alone must not conclude absence. Suppress one observation.
      if (loseDeleteInspection) { loseDeleteInspection = false; return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; }
      return real.inspect(ref, expected, input);
    },
    remove: (ref, input) => real.remove(ref, input),
  };
  function core(store = objectStore) {
    return createDurablePrivateMediaStore({ encryptionKey, profile, objectStore: store, maxStorageBytes, requestTimeoutMs: 5_000,
      transact: db.transact, cleanupTransact: <T>(work: Parameters<typeof withLifecycleWorkerTransaction<T>>[1]) => withLifecycleWorkerTransaction(lifecycle, work) });
  }
  const privateStore = core();
  function facade(privatePort = privateStore) {
    return createMediaStore({ encryptionKey, maxStorageBytes, transact: db.transact, privateStore: privatePort,
      download: async asset => { downloads.push(asset); return file; } });
  }
  return { real, objectStore, privateStore, core, facade, http, downloads,
    losePutReceipt: () => { losePutReceipt = true; }, loseDeleteInspection: () => { loseDeleteInspection = true; },
    afterRead: (work: () => Promise<void>) => { afterRead = work; } };
}
async function deletion(t: Awaited<ReturnType<typeof tenant>>, kind: 'channel' | 'organization') {
  const id = kind === 'channel'
    ? (await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id', [t.org, t.instance, 'Synthetic MinIO media', 'Synthetic local media cleanup', 'TENANT', t.actor])).rows[0]!.id as string
    : (await platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4) AS id', [t.org, 'Attendance', 'Synthetic local media cleanup', platformActor])).rows[0]!.id as string;
  const lease = randomUUID();
  // Synthetic provider cleanup jobs only; this is not an Evolution deployment.
  await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1", [id]);
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [id, lease]);
  return { id, lease, kind };
}
async function purge(d: Awaited<ReturnType<typeof deletion>>) {
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA' WHERE id=$1", [d.id]);
  return lifecycle.query(`SELECT lifecycle_purge_${d.kind}($1,$2)`, [d.id, d.lease]);
}
async function drainAndPurge(t: Awaited<ReturnType<typeof tenant>>, store: ReturnType<typeof createDurablePrivateMediaStore>) {
  const d = await deletion(t, 'organization'); await store.prepareCleanup(d.id, d.lease);
  for (let n = 0; n < 10 && await store.runCleanupOnce(d.id, d.lease); n++) { /* one durable operation per tick */ }
  expect((await lifecycle.query('SELECT lifecycle_pending_count($1,NULL,NULL) AS count', [t.org])).rows).toEqual([{ count: '0' }]);
  await purge(d);
}

beforeAll(async () => {
  // Real conditional-write capability is a prerequisite, not an inferred version.
  const real = adapter(), ref: PrivateObjectRef = { organizationId: randomUUID(), channelId: randomUUID(), mediaId: randomUUID(), operationId: randomUUID() };
  const original = new Uint8Array(Buffer.from('synthetic conditional ciphertext A')), replacement = new Uint8Array(Buffer.from('synthetic conditional ciphertext B'));
  try {
    expect(await real.put(ref, original, { byteLength: original.byteLength, sha256: hash(original) }, control())).toEqual({ outcome: 'CONFIRMED' });
    expect(await real.put(ref, replacement, { byteLength: replacement.byteLength, sha256: hash(replacement) }, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_CONFLICT' });
    expect(await real.read(ref, { byteLength: original.byteLength, sha256: hash(original) }, control())).toEqual({ outcome: 'CONFIRMED', bytes: original });
    const anonymous = await fetch(new URL('/' + bucket + '/' + privateObjectKey(profile, ref), endpoint), { signal: AbortSignal.timeout(5000) });
    await anonymous.body?.cancel(); expect(anonymous.status).toBe(403);
  } finally {
    // This separate disposable-bucket capability probe is intentionally outside the kernel.
    await real.remove(ref, control());
    expect(await real.inspect(ref, { byteLength: original.byteLength, sha256: hash(original) }, control())).toEqual({ outcome: 'MISSING' });
  }
  db = await attendanceDatabase(); lifecycle = rolePool('jrc_lifecycle'); platform = rolePool('jrc_platform');
  const t = await tenant();
  const id = await db.transact(t.org, tx => registerLegacyPendingMedia(tx, t.org, t.channel, {
    source: 'META', sourceKey: randomUUID(), kind: 'document', fileName: file.fileName, descriptor: { mediaId: '11111' },
  }));
  await createLegacyMediaStore({ encryptionKey, transact: db.transact, download: async () => file }).runOnce(t.org);
  historical = { tenant: t, id, row: await media(id) };
  platformActor = randomUUID();
  await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')", [platformActor, `${platformActor}@example.test`]);
});
afterAll(async () => { await lifecycle?.end(); await platform?.end(); await db?.dispose(); });

it('combines the real facade PUT/read with untouched INLINE_V1 history and mixed plain-byte quota', async () => {
  const t = historical.tenant, h = setup(11), store = h.facade(), original = await media(historical.id);
  for (const [key, value] of Object.entries(historical.row)) expect(original[key]).toEqual(value);
  expect(original).toMatchObject({ storage_backend: 'INLINE_V1', private_object_id: null });
  expect(await store.read(t.org, historical.id)).toEqual(file); expect(h.http).toEqual([]);
  const id = await pending(t); expect(await store.runOnce(t.org)).toBeUndefined();
  const row = await media(id);
  expect(row).toMatchObject({ status: 'READY', storage_backend: 'PRIVATE_OBJECT', encrypted_data: null, byte_size: 5, sha256: hash(file.bytes), lease_token: null });
  expect(await object(row.private_object_id)).toMatchObject({ state: 'READY', reserved_bytes: 5, destination_fingerprint: h.real.destinationFingerprint });
  expect(await operation(row.private_object_id)).toMatchObject({ state: 'CONFIRMED' });
  expect(await object(row.private_object_id)).toMatchObject({ staging_ciphertext: null });
  expect(await store.read(t.org, id)).toEqual(file); expect(h.downloads).toHaveLength(1);
  const overflow = await pending(t); await store.runOnce(t.org);
  expect(await media(overflow)).toMatchObject({ status: 'FAILED', last_error: 'MEDIA_STORAGE_LIMIT', private_object_id: null });
  expect(h.http.filter(event => event.method === 'PUT')).toEqual([{ method: 'PUT', status: 200 }]);
  await drainAndPurge(t, h.privateStore);
});

it('reconciles a lost real PUT receipt after restart and suspension, then reads after reactivation without PUT replay', async () => {
  const t = await tenant(), id = await pending(t), h = setup(); h.losePutReceipt();
  await h.facade().runOnce(t.org); const row = await media(id);
  expect(row).toMatchObject({ status: 'STORING', storage_backend: 'PRIVATE_OBJECT' });
  expect(await operation(row.private_object_id)).toMatchObject({ state: 'UNKNOWN', lease_token: null });
  await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [t.org]);
  const restarted = h.core(), store = h.facade(restarted); await store.runOnce(t.org);
  expect(await media(id)).toMatchObject({ status: 'READY' });
  await expect(store.read(t.org, id)).rejects.toMatchObject({ code: 'RESOURCE_DELETING' });
  await db.database.pool.query("UPDATE organizations SET status='ACTIVE' WHERE id=$1", [t.org]);
  expect(await store.read(t.org, id)).toEqual(file); await store.retry(t.org, id); await store.runOnce(t.org);
  expect(h.downloads).toHaveLength(1); expect(h.http.filter(event => event.method === 'PUT')).toHaveLength(1);
  expect(await operation(row.private_object_id)).toMatchObject({ state: 'CONFIRMED' });
  await drainAndPurge(t, restarted);
});

it('blocks foreign refs, a changed destination and revoked read authority after real I/O', async () => {
  const t = await tenant(), other = await tenant(), id = await pending(t), h = setup(); await h.facade().runOnce(t.org);
  const prior = h.http.length;
  await expect(h.facade().read(other.org, id)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
  let wrongCalls = 0;
  const wrong = h.core(adapter(async () => { wrongCalls++; throw new Error('UNEXPECTED_WRONG_DESTINATION_IO'); }, 'broker-c2b-other'));
  await expect(h.facade(wrong).read(t.org, id)).rejects.toMatchObject({ code: 'MEDIA_OBJECT_DESTINATION_MISMATCH' });
  expect(h.http).toHaveLength(prior); expect(wrongCalls).toBe(0);
  const authVersion = (await db.database.pool.query('SELECT auth_version FROM users WHERE id=$1', [t.actor])).rows[0]!.auth_version as number;
  let checks = 0; h.afterRead(async () => { await db.database.pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [t.actor]); });
  await expect(h.facade().read(t.org, id, { authorize: async tx => {
    checks++; const current = (await tx.query<{ valid: boolean }>('SELECT current_tenant_authentication_valid($1,$2) AS valid', [t.actor, authVersion])).rows[0]!.valid;
    if (!current) throw new Error('SYNTHETIC_READ_AUTHORITY_REVOKED');
  } }))
    .rejects.toThrow('SYNTHETIC_READ_AUTHORITY_REVOKED');
  expect(checks).toBe(2); expect(h.http.filter(event => event.method === 'GET' && event.status === 200)).toHaveLength(1);
  await drainAndPurge(t, h.privateStore); await drainAndPurge(other, h.privateStore);
});

it('requires exact real absence after a DELETE ACK before channel purge and preserves a different tenant', async () => {
  const t = await tenant(), other = await tenant(), a = await pending(t), b = await pending(other), h = setup(), store = h.facade();
  await store.runOnce(t.org); await store.runOnce(other.org); const row = await media(a), d = await deletion(t, 'channel');
  expect(await h.privateStore.prepareCleanup(d.id, d.lease)).toBe(1); h.loseDeleteInspection();
  await h.privateStore.runCleanupOnce(d.id, d.lease);
  expect(await object(row.private_object_id)).toMatchObject({ state: 'DELETING', reserved_bytes: 5 });
  expect(await operation(row.private_object_id, 'DELETE')).toMatchObject({ state: 'UNKNOWN' });
  await expect(purge(d)).rejects.toMatchObject({ constraint: 'lifecycle_pending_work' });
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL' WHERE id=$1", [d.id]);
  await h.privateStore.runCleanupOnce(d.id, d.lease);
  expect(await object(row.private_object_id)).toMatchObject({ state: 'DELETED', reserved_bytes: 0 });
  expect(await operation(row.private_object_id, 'DELETE')).toMatchObject({ state: 'CONFIRMED' });
  expect(h.http.filter(event => event.method === 'DELETE')).toHaveLength(1);
  await purge(d); expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1', [t.channel])).rows).toEqual([]);
  expect(await store.read(other.org, b)).toEqual(file); await drainAndPurge(other, h.privateStore);
});

it('drains a real DISABLED organization using the current lifecycle actor/lease and absence, with no new PUT', async () => {
  const t = await tenant(), id = await pending(t), h = setup(), store = h.facade(); await store.runOnce(t.org);
  const row = await media(id), d = await deletion(t, 'organization');
  expect((await db.database.pool.query('SELECT status FROM organizations WHERE id=$1', [t.org])).rows).toEqual([{ status: 'DISABLED' }]);
  await expect(store.read(t.org, id)).rejects.toMatchObject({ code: 'RESOURCE_DELETING' });
  expect(await h.privateStore.prepareCleanup(d.id, d.lease)).toBe(1); await h.privateStore.runCleanupOnce(d.id, d.lease);
  expect(await object(row.private_object_id)).toMatchObject({ state: 'DELETED', reserved_bytes: 0 });
  expect(await operation(row.private_object_id, 'DELETE')).toMatchObject({ state: 'CONFIRMED' });
  expect(h.http.filter(event => event.method === 'PUT')).toHaveLength(1);
  expect(h.http.filter(event => event.method === 'DELETE')).toHaveLength(1);
  expect((await lifecycle.query('SELECT lifecycle_pending_count($1,NULL,NULL) AS count', [t.org])).rows).toEqual([{ count: '0' }]);
  await purge(d); expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1', [t.org])).rows).toEqual([]);
});
