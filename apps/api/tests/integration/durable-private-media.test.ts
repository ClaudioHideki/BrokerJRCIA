import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { BinaryMedia } from '@jrc/providers';
import type { PrivateObjectStore, PrivateObjectRef, ExpectedCiphertext, ObjectStoreControl } from '../../src/modules/messaging/private-object-store.js';
import { createS3PrivateObjectStore } from '../../src/modules/messaging/private-object-store.js';
import { createMediaStore } from '../../src/modules/messaging/media-store.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import { lockAttendanceChannel } from '../../src/modules/attendance/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { withLifecycleWorkerTransaction } from '../../src/modules/lifecycle/service.js';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { queryAsTenant, requireTestDatabaseAdminUrl } from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { createDurablePrivateMediaStore, type DurablePrivateMediaOptions } from '../../src/modules/messaging/durable-private-media.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const file: BinaryMedia = { bytes: new Uint8Array(Buffer.from('hello')), mimeType: 'application/pdf', kind: 'document', fileName: 'synthetic.pdf' };
const plainHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
let db: Awaited<ReturnType<typeof attendanceDatabase>>;
let lifecycle: Pool, platform: Pool;
let historical: { org: string; media: string; row: Record<string, unknown> };

function rolePool(role: string) {
  const url = new URL(db.database.connectionString); url.username = role; url.password = '';
  return new Pool({ connectionString: url.href, max: 2 });
}
async function tenant() {
  const t = await seedAttendanceTenant(db.database, false), instance = randomUUID();
  const provider = (await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1', [t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("UPDATE provider_accounts SET provider='BAILEYS' WHERE organization_id=$1 AND id=$2", [t.org, provider]);
  await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Synthetic media',$4,'CONNECTED')", [instance, t.org, provider, `synthetic-${instance}`]);
  await db.database.pool.query("UPDATE messaging_channels SET provider='BAILEYS',instance_id=$3,phone_number_id=NULL,waba_id=NULL WHERE organization_id=$1 AND id=$2", [t.org, t.channel, instance]);
  return { ...t, instance, actor: (await db.database.pool.query("SELECT user_id FROM memberships WHERE organization_id=$1 AND role='OWNER'", [t.org])).rows[0]!.user_id as string };
}
async function pending(t: { org: string; channel: string }) {
  return (await db.database.pool.query(`INSERT INTO messaging_media(organization_id,channel_id,source,source_key,kind,file_name,descriptor)
    VALUES($1,$2,'META',$3,'document','synthetic.pdf','{"mediaId":"11111"}') RETURNING id`, [t.org, t.channel, randomUUID()])).rows[0]!.id as string;
}
const destinationConfig = { endpoint: 'https://objects.example.test/', bucket: 'broker-private', region: 'us-east-1', profile: 'private-v1' };
function destinationFingerprint(config = destinationConfig) {
  return createHash('sha256').update(JSON.stringify(['jrc-private-object-destination:v1', new URL(config.endpoint).href,
    config.bucket, config.region, config.profile, 'path-style/profile/org/channel/media/operation.cipher:v1'])).digest('hex');
}
function transport(config = destinationConfig) {
  const bodies = new Map<string, Uint8Array>(), actions: string[] = [];
  const check = (ref: PrivateObjectRef, expected: ExpectedCiphertext, bytes: Uint8Array) => {
    expect(ref.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(bytes.byteLength).toBe(expected.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
  };
  const objectStore: PrivateObjectStore & { readonly destinationFingerprint: string } = {
    destinationFingerprint: destinationFingerprint(config),
    async put(ref, bytes, expected, control) {
      expect(control.deadline.getTime()).toBeGreaterThan(Date.now()); check(ref, expected, bytes);
      actions.push('PUT'); bodies.set(ref.operationId, new Uint8Array(bytes)); return { outcome: 'CONFIRMED' };
    },
    async read(ref, expected) {
      actions.push('GET'); const bytes = bodies.get(ref.operationId);
      if (!bytes) return { outcome: 'MISSING' }; check(ref, expected, bytes);
      return { outcome: 'CONFIRMED', bytes: new Uint8Array(bytes) };
    },
    async inspect(ref, expected) {
      actions.push('INSPECT'); const bytes = bodies.get(ref.operationId);
      if (!bytes) return { outcome: 'MISSING' }; check(ref, expected, bytes);
      return { outcome: 'CONFIRMED', byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    },
    async remove(ref) { actions.push('DELETE'); bodies.delete(ref.operationId); return { outcome: 'CONFIRMED' }; },
  };
  return { objectStore, bodies, actions };
}
function core(h: ReturnType<typeof transport>, maxStorageBytes = 100, overrides: Partial<DurablePrivateMediaOptions> = {}) {
  return createDurablePrivateMediaStore({ transact: db.transact,
    cleanupTransact: <T>(work: Parameters<typeof withLifecycleWorkerTransaction<T>>[1]) => withLifecycleWorkerTransaction(lifecycle, work),
    objectStore: h.objectStore, profile: 'private-v1', encryptionKey, maxStorageBytes, requestTimeoutMs: 1_000, ...overrides });
}
async function object(id: string) { return (await db.database.pool.query('SELECT * FROM media_private_objects WHERE id=$1', [id])).rows[0]!; }
async function operation(id: string, kind = 'PUT') {
  return (await db.database.pool.query('SELECT * FROM media_private_operations WHERE object_id=$1 AND kind=$2', [id, kind])).rows[0]!;
}
async function organizationDeletion(t: Awaited<ReturnType<typeof tenant>>) {
  const actor = randomUUID();
  await db.database.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')", [actor, `${actor}@example.test`]);
  const id = (await platform.query('SELECT lifecycle_request_organization($1,$2,$3,$4) AS id', [t.org, 'Attendance', 'Synthetic private media deletion', actor])).rows[0]!.id as string;
  const lease = randomUUID();
  await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1", [id]);
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL',lease_token=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1", [id, lease]);
  return { id, lease, actor };
}
async function channelDeletion(t: Awaited<ReturnType<typeof tenant>>) {
  const id = (await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id', [t.org, t.instance, 'Synthetic media', 'Synthetic channel media deletion', 'TENANT', t.actor])).rows[0]!.id as string;
  const lease = randomUUID();
  await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1", [id]);
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL',lease_token=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1", [id, lease]);
  return { id, lease };
}
async function purge(deletion: { id: string; lease: string }, kind: 'organization' | 'channel') {
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='REMOVING_DATA' WHERE id=$1", [deletion.id]);
  return lifecycle.query(`SELECT lifecycle_purge_${kind}($1,$2)`, [deletion.id, deletion.lease]);
}

beforeAll(async () => {
  db = await attendanceDatabase(); lifecycle = rolePool('jrc_lifecycle'); platform = rolePool('jrc_platform');
  const t = await tenant(), media = await pending(t);
  const encrypted = createIntegrationSecrets(encryptionKey).encrypt(`${t.org}:media:${media}`, 'aGVsbG8=');
  await db.database.pool.query("UPDATE messaging_media SET status='READY',encrypted_data=$2,byte_size=5,sha256=$3,mime_type='application/pdf' WHERE id=$1", [media, encrypted, plainHash]);
  historical = { org: t.org, media, row: (await db.database.pool.query('SELECT * FROM messaging_media WHERE id=$1', [media])).rows[0]! };
});
afterAll(async () => { await lifecycle?.end(); await platform?.end(); await db?.dispose(); });

it('adds forced tenant objects and operations without manufacturing historical objects or changing inline v1 bytes', async () => {
  expect((await db.database.pool.query("SELECT to_regclass('media_private_objects') AS objects,to_regclass('media_private_operations') AS operations")).rows).toEqual([{ objects: 'media_private_objects', operations: 'media_private_operations' }]);
  const row = (await db.database.pool.query('SELECT * FROM messaging_media WHERE id=$1', [historical.media])).rows[0]!;
  for (const [key, value] of Object.entries(historical.row)) expect(row[key]).toEqual(value);
  expect(row.storage_backend).toBe('INLINE_V1'); expect(row.private_object_id).toBeNull();
  expect((await db.database.pool.query('SELECT id FROM media_private_objects WHERE organization_id=$1', [historical.org])).rows).toEqual([]);
  const old = createMediaStore({ encryptionKey, transact: db.transact, download: async () => file });
  expect(await old.read(historical.org, historical.media)).toEqual(file);
  const historicalTransport = transport();
  expect(await core(historicalTransport).read(historical.org, historical.media)).toEqual(file);
  expect(historicalTransport.actions).toEqual([]);
  expect((await db.database.pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('media_private_objects','media_private_operations') ORDER BY relname")).rows).toEqual([
    { relname: 'media_private_objects', relrowsecurity: true, relforcerowsecurity: true },
    { relname: 'media_private_operations', relrowsecurity: true, relforcerowsecurity: true },
  ]);
});

it('commits immutable encrypted staging, quota and DISPATCHED lease before PUT then publishes only confirmed ciphertext', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  const staged = await store.stage(t.org, media, file);
  expect(h.actions).toEqual([]); expect((await object(staged.objectId)).reserved_bytes).toBe(5);
  h.objectStore.put = async (ref, ciphertext, expected, control) => {
    const attempt = await operation(ref.operationId);
    expect(attempt.state).toBe('DISPATCHED'); expect(attempt.dispatched_at).toBeInstanceOf(Date);
    expect(attempt.lease_token).toMatch(/^[a-f0-9-]{36}$/); expect(attempt.lease_expires_at.getTime()).toBeGreaterThan(control.deadline.getTime());
    const row = await object(ref.operationId);
    expect(ref).toEqual({ organizationId: t.org, channelId: t.channel, mediaId: media, operationId: staged.objectId });
    expect(Buffer.from(ciphertext).toString('utf8')).toBe(row.staging_ciphertext);
    expect(createIntegrationSecrets(encryptionKey).decrypt(`${t.org}:media:${media}`, row.staging_ciphertext)).toBe('aGVsbG8=');
    expect(expected).toEqual({ byteLength: Number(row.cipher_byte_length), sha256: row.cipher_sha256 });
    h.bodies.set(ref.operationId, new Uint8Array(ciphertext)); h.actions.push('PUT'); return { outcome: 'CONFIRMED' };
  };
  expect(await store.dispatchPut(t.org, staged.objectId)).toBe('CONFIRMED');
  const row = (await db.database.pool.query('SELECT * FROM messaging_media WHERE id=$1', [media])).rows[0]!;
  expect(row).toMatchObject({ storage_backend: 'PRIVATE_OBJECT', status: 'READY', encrypted_data: null, byte_size: 5, sha256: plainHash });
  expect(await object(staged.objectId)).toMatchObject({ state: 'READY', staging_ciphertext: null, reserved_bytes: 5 });
  expect(await store.read(t.org, media)).toEqual(file);
});

it('reconciles a committed remote PUT after an uncertain ACK by exact bytes without another PUT', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  h.objectStore.put = async (ref, ciphertext) => { h.actions.push('PUT'); h.bodies.set(ref.operationId, new Uint8Array(ciphertext)); return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; };
  const staged = await store.stage(t.org, media, file);
  expect(await store.dispatchPut(t.org, staged.objectId)).toBe('UNKNOWN');
  expect(await operation(staged.objectId)).toMatchObject({ state: 'UNKNOWN', lease_token: null });
  expect(await store.runOnce(t.org)).toBe(true);
  expect(await operation(staged.objectId)).toMatchObject({ state: 'CONFIRMED' });
  expect(h.actions).toEqual(['PUT', 'INSPECT']);
  expect(await store.read(t.org, media)).toEqual(file);
});

it('keeps a missing uncertain PUT unresolved and reserved instead of replaying or releasing quota', async () => {
  const t = await tenant(), media = await pending(t), next = await pending(t), h = transport(), store = core(h, 6);
  h.objectStore.put = async () => { h.actions.push('PUT'); return { outcome: 'UNKNOWN', code: 'OBJECT_DEADLINE_EXCEEDED' }; };
  const staged = await store.stage(t.org, media, file);
  await store.dispatchPut(t.org, staged.objectId); await store.reconcilePut(t.org, staged.objectId); await store.runOnce(t.org);
  expect(h.actions).toEqual(['PUT', 'INSPECT', 'INSPECT']);
  expect(await operation(staged.objectId)).toMatchObject({ state: 'UNKNOWN', last_error_code: 'MEDIA_OBJECT_NOT_OBSERVED' });
  expect(await object(staged.objectId)).toMatchObject({ state: 'STAGED', reserved_bytes: 5 });
  await expect(store.stage(t.org, next, file)).rejects.toThrow('MEDIA_STORAGE_LIMIT');
});

it('does not treat a conflicting existing key or mismatched inspection as rejected absence', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  h.objectStore.put = async () => ({ outcome: 'REJECTED', code: 'OBJECT_CONFLICT' });
  h.objectStore.inspect = async () => ({ outcome: 'CONFIRMED', byteLength: 3, sha256: 'a'.repeat(64) });
  const staged = await store.stage(t.org, media, file);
  expect(await store.dispatchPut(t.org, staged.objectId)).toBe('UNKNOWN');
  expect(await store.reconcilePut(t.org, staged.objectId)).toBe('UNKNOWN');
  expect(await operation(staged.objectId)).toMatchObject({ state: 'UNKNOWN', last_error_code: 'MEDIA_OBJECT_INTEGRITY_FAILED' });
  expect((await object(staged.objectId)).reserved_bytes).toBe(5);
});

it('recovers expired dispatch without echo as UNKNOWN and never replays it', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  const staged = await store.stage(t.org, media, file);
  await db.database.pool.query("UPDATE media_private_operations SET state='DISPATCHED',dispatched_at=clock_timestamp()-interval '2 minutes',lease_token=$2,lease_expires_at=now()-interval '1 second' WHERE object_id=$1", [staged.objectId, randomUUID()]);
  expect(await store.recoverExpired(t.org)).toBe(1); await store.runOnce(t.org);
  expect(await operation(staged.objectId)).toMatchObject({ state: 'UNKNOWN', lease_token: null });
  expect(h.actions).toEqual(['INSPECT']);
});

it('serializes simultaneous quota reservations and prevents foreign tenant references and mutable profiles', async () => {
  const t = await tenant(), other = await tenant(), a = await pending(t), b = await pending(t), h = transport(), store = core(h, 5);
  const results = await Promise.allSettled([store.stage(t.org, a, file), store.stage(t.org, b, file)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  const id = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ objectId: string }>).value.objectId;
  expect((await db.database.pool.query('SELECT sum(reserved_bytes)::integer AS bytes FROM media_private_objects WHERE organization_id=$1', [t.org])).rows).toEqual([{ bytes: 5 }]);
  await expect(store.dispatchPut(other.org, id)).rejects.toThrow('MEDIA_NOT_FOUND');
  expect((await queryAsTenant(db.database.pool, 'jrc_app', other.org, 'SELECT id FROM media_private_objects WHERE id=$1', [id])).rows).toEqual([]);
  await expect(queryAsTenant(db.database.pool, 'jrc_app', t.org, "UPDATE media_private_objects SET profile='foreign-v1' WHERE id=$1", [id])).rejects.toMatchObject({ code: '23514' });
  await expect(queryAsTenant(db.database.pool, 'jrc_app', t.org, 'DELETE FROM media_private_objects WHERE id=$1', [id])).rejects.toMatchObject({ code: '42501' });
  expect(h.actions).toEqual([]);
});

it('rejects staging behind the real channel fence before reserving or performing object I/O', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  await db.database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE id=$1', [t.channel]);
  await expect(store.stage(t.org, media, file)).rejects.toThrow('RESOURCE_DELETING');
  expect((await db.database.pool.query('SELECT id FROM media_private_objects WHERE organization_id=$1', [t.org])).rows).toEqual([]);
  expect(h.actions).toEqual([]);
});

it('rechecks the channel fence after a remote read before releasing plaintext', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  await store.dispatchPut(t.org, staged.objectId);
  const realRead = h.objectStore.read;
  h.objectStore.read = async (ref, expected, control) => {
    await db.database.pool.query('UPDATE messaging_channels SET deleting_at=now() WHERE id=$1', [t.channel]);
    return realRead(ref, expected, control);
  };
  await expect(store.read(t.org, media)).rejects.toThrow('RESOURCE_DELETING');
});

it('blocks real organization deletion while a PUT remains uncertain, retaining its reservation', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  h.objectStore.put = async () => ({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  const staged = await store.stage(t.org, media, file); await store.dispatchPut(t.org, staged.objectId);
  await expect(organizationDeletion(t)).rejects.toMatchObject({ code: '23514', constraint: 'lifecycle_pending_work' });
  expect((await object(staged.objectId)).reserved_bytes).toBe(5);
  expect((await db.database.pool.query('SELECT status FROM organizations WHERE id=$1', [t.org])).rows).toEqual([{ status: 'ACTIVE' }]);
});

it('cancels a never-dispatched staged PUT on real deletion without fabricating an object or sending it', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  const deletion = await organizationDeletion(t);
  expect(await object(staged.objectId)).toMatchObject({ state: 'REJECTED', reserved_bytes: 0, staging_ciphertext: null });
  expect(await operation(staged.objectId)).toMatchObject({ state: 'REJECTED', dispatched_at: null });
  expect(await store.prepareCleanup(deletion.id, deletion.lease)).toBe(0);
  await purge(deletion, 'organization'); expect(h.actions).toEqual([]);
});

it('cleans a DISABLED organization but does not conclude DELETE from an ACK or replay a surviving object', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  await store.dispatchPut(t.org, staged.objectId); const deletion = await organizationDeletion(t);
  expect((await db.database.pool.query('SELECT status FROM organizations WHERE id=$1', [t.org])).rows).toEqual([{ status: 'DISABLED' }]);
  expect(await store.prepareCleanup(deletion.id, deletion.lease)).toBe(1);
  h.objectStore.remove = async () => { h.actions.push('DELETE'); return { outcome: 'CONFIRMED' }; };
  await store.runCleanupOnce(deletion.id, deletion.lease);
  expect(await operation(staged.objectId, 'DELETE')).toMatchObject({ state: 'UNKNOWN', last_error_code: 'MEDIA_OBJECT_STILL_PRESENT' });
  expect((await object(staged.objectId)).reserved_bytes).toBe(5);
  await expect(purge(deletion, 'organization')).rejects.toMatchObject({ code: '23514', constraint: 'lifecycle_pending_work' });
  await store.runCleanupOnce(deletion.id, deletion.lease);
  expect(h.actions.filter(a => a === 'DELETE')).toHaveLength(1);
  h.bodies.delete(staged.objectId); await store.runCleanupOnce(deletion.id, deletion.lease);
  expect(await object(staged.objectId)).toMatchObject({ state: 'DELETED', reserved_bytes: 0 });
  expect(await operation(staged.objectId, 'DELETE')).toMatchObject({ state: 'CONFIRMED' });
  expect((await lifecycle.query('SELECT lifecycle_pending_count($1,NULL,NULL) AS count', [t.org])).rows).toEqual([{ count: '0' }]);
  await purge(deletion, 'organization');
  expect((await db.database.pool.query('SELECT id FROM organizations WHERE id=$1', [t.org])).rows).toEqual([]);
});

it('drains a real channel deletion only after exact absence and preserves another tenant', async () => {
  const t = await tenant(), survivor = await tenant(), media = await pending(t), keep = await pending(survivor), h = transport(), store = core(h);
  const a = await store.stage(t.org, media, file), b = await store.stage(survivor.org, keep, file);
  await store.dispatchPut(t.org, a.objectId); await store.dispatchPut(survivor.org, b.objectId);
  const deletion = await channelDeletion(t); await store.prepareCleanup(deletion.id, deletion.lease);
  await store.runCleanupOnce(deletion.id, deletion.lease); await purge(deletion, 'channel');
  expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1', [t.channel])).rows).toEqual([]);
  expect(await store.read(survivor.org, keep)).toEqual(file);
});

it('refuses cleanup with an expired lease or revoked nominative actor before DELETE', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  await store.dispatchPut(t.org, staged.objectId); const deletion = await organizationDeletion(t);
  await store.prepareCleanup(deletion.id, deletion.lease);
  await db.database.pool.query('UPDATE platform_users SET active=false WHERE id=$1', [deletion.actor]);
  await expect(store.runCleanupOnce(deletion.id, deletion.lease)).rejects.toThrow('LIFECYCLE_ACTOR_REVOKED');
  expect(h.actions).toEqual(['PUT']);
  await db.database.pool.query('UPDATE platform_users SET active=true WHERE id=$1', [deletion.actor]);
  await db.database.pool.query("UPDATE lifecycle_deletions SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [deletion.id]);
  await expect(store.runCleanupOnce(deletion.id, deletion.lease)).rejects.toThrow('LIFECYCLE_LEASE_LOST');
  expect(h.actions).toEqual(['PUT']);
});

it('preserves a committed DISPATCHED claim after losing its commit receipt without issuing PUT', async () => {
  const t = await tenant(), media = await pending(t), h = transport();
  let loseReceipt = false;
  const store = core(h, 100, { transact: async (org, work) => {
    const result = await db.transact(org, work);
    if (loseReceipt) { loseReceipt = false; throw new Error('SYNTHETIC_COMMIT_RECEIPT_LOST'); }
    return result;
  } });
  const staged = await store.stage(t.org, media, file); loseReceipt = true;
  await expect(store.dispatchPut(t.org, staged.objectId)).rejects.toThrow('SYNTHETIC_COMMIT_RECEIPT_LOST');
  expect((await operation(staged.objectId)).state).toBe('DISPATCHED'); expect(h.actions).toEqual([]);
  await db.database.pool.query("UPDATE media_private_operations SET lease_expires_at=dispatched_at+interval '1 microsecond' WHERE object_id=$1", [staged.objectId]);
  await store.runOnce(t.org);
  expect((await operation(staged.objectId)).state).toBe('UNKNOWN'); expect(h.actions).toEqual(['INSPECT']);
});

it('rolls back failed persistence after confirmed PUT and recovers its exact object without retransmission', async () => {
  const t = await tenant(), media = await pending(t), h = transport();
  let rollbackFinalization = false;
  const store = core(h, 100, { transact: (org, work) => db.transact(org, async tx => {
    const result = await work(tx);
    if (rollbackFinalization) { rollbackFinalization = false; throw new Error('SYNTHETIC_FINALIZATION_ROLLBACK'); }
    return result;
  }) });
  h.objectStore.put = async (ref, bytes) => {
    h.actions.push('PUT'); h.bodies.set(ref.operationId, new Uint8Array(bytes)); rollbackFinalization = true;
    return { outcome: 'CONFIRMED' };
  };
  const staged = await store.stage(t.org, media, file);
  await expect(store.dispatchPut(t.org, staged.objectId)).rejects.toThrow('SYNTHETIC_FINALIZATION_ROLLBACK');
  expect((await operation(staged.objectId)).state).toBe('DISPATCHED'); expect((await object(staged.objectId)).state).toBe('STAGED');
  await db.database.pool.query("UPDATE media_private_operations SET lease_expires_at=dispatched_at+interval '1 microsecond' WHERE object_id=$1", [staged.objectId]);
  await store.runOnce(t.org);
  expect((await operation(staged.objectId)).state).toBe('CONFIRMED'); expect(h.actions).toEqual(['PUT', 'INSPECT']);
  expect(await store.read(t.org, media)).toEqual(file);
});

it('requires the current unexpired download lease when staging a claimed legacy download', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), lease = randomUUID();
  await db.database.pool.query("UPDATE messaging_media SET status='DOWNLOADING',lease_token=$2,lease_expires_at=now()+interval '1 minute' WHERE id=$1", [media, lease]);
  await expect(store.stage(t.org, media, file, { downloadLeaseToken: randomUUID() })).rejects.toThrow('MEDIA_LEASE_LOST');
  await db.database.pool.query("UPDATE messaging_media SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [media]);
  await expect(store.stage(t.org, media, file, { downloadLeaseToken: lease })).rejects.toThrow('MEDIA_LEASE_LOST');
  expect((await db.database.pool.query('SELECT id FROM media_private_objects WHERE media_id=$1', [media])).rows).toEqual([]);
  await db.database.pool.query("UPDATE messaging_media SET lease_expires_at=now()+interval '1 minute' WHERE id=$1", [media]);
  expect((await store.stage(t.org, media, file, { downloadLeaseToken: lease })).state).toBe('STAGED');
});

it('rejects staging after a download lease expires waiting for a row lock without updating the row', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), lease = randomUUID();
  let workerPid = 0;
  const store = core(h, 100, { transact: (org, work) => db.transact(org, async tx => {
    workerPid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return work(tx);
  }) });
  const holder = await db.database.pool.connect();
  let pendingStage: Promise<{ result?: unknown; error?: unknown }> | undefined;
  try {
    await holder.query("UPDATE messaging_media SET status='DOWNLOADING',lease_token=$2,lease_expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1", [media,lease]);
    await holder.query('BEGIN'); await holder.query('SELECT id FROM messaging_media WHERE id=$1 FOR UPDATE', [media]);
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    pendingStage = store.stage(t.org, media, file, { downloadLeaseToken: lease }).then(() => ({ result:true }), error => ({ error }));
    let blocked = false;
    for (let i = 0; i < 200; i++) {
      if (workerPid && (await db.database.pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked',[holderPid,workerPid])).rows[0]!.blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve,10));
    }
    expect(blocked).toBe(true);
    expect((await holder.query('SELECT lease_expires_at>clock_timestamp() AS live FROM messaging_media WHERE id=$1',[media])).rows).toEqual([{live:true}]);
    await holder.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM lease_expires_at-clock_timestamp()))+0.05) FROM messaging_media WHERE id=$1',[media]);
    await holder.query('COMMIT');
    expect(await pendingStage).toMatchObject({error:{message:'MEDIA_LEASE_LOST'}});
  } finally {
    await holder.query('ROLLBACK'); if (pendingStage) await pendingStage; holder.release();
  }
  expect((await db.database.pool.query('SELECT id FROM media_private_objects WHERE media_id=$1',[media])).rows).toEqual([]);
  expect((await db.database.pool.query('SELECT status,lease_token FROM messaging_media WHERE id=$1',[media])).rows).toEqual([{status:'DOWNLOADING',lease_token:lease}]);
  expect(h.actions).toEqual([]);
});

it('uses PostgreSQL time after the deletion lock when the application clock is behind an expired cleanup lease', async () => {
  const t = await tenant(), h = transport(), store = core(h), d = await organizationDeletion(t);
  await db.database.pool.query("UPDATE lifecycle_deletions SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [d.id]);
  const appClock = vi.spyOn(Date,'now').mockReturnValue(Date.now()-300_000);
  try { await expect(store.prepareCleanup(d.id,d.lease)).rejects.toThrow('LIFECYCLE_LEASE_LOST'); }
  finally { appClock.mockRestore(); }
  expect((await db.database.pool.query('SELECT id FROM media_private_operations WHERE deletion_id=$1',[d.id])).rows).toEqual([]);
  expect(h.actions).toEqual([]);
});

it('does not widen cleanup of a QR instance without a channel to other READY and UNKNOWN media in the same tenant', async () => {
  const t = await tenant(), h = transport(), store = core(h), readyMedia = await pending(t), unknownMedia = await pending(t);
  const ready = await store.stage(t.org,readyMedia,file); await store.dispatchPut(t.org,ready.objectId);
  h.objectStore.put = async () => { h.actions.push('PUT_UNKNOWN'); return {outcome:'UNKNOWN',code:'OBJECT_REQUEST_UNVERIFIED'}; };
  const unknown = await store.stage(t.org,unknownMedia,file); await store.dispatchPut(t.org,unknown.objectId);
  const orphan = randomUUID(), provider = (await db.database.pool.query('SELECT provider_account_id FROM messaging_channels WHERE id=$1',[t.channel])).rows[0]!.provider_account_id;
  await db.database.pool.query("INSERT INTO instances(id,organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,$3,'Synthetic orphan QR',$4,'CONNECTED')",[orphan,t.org,provider,`synthetic-${orphan}`]);
  const d = (await platform.query('SELECT lifecycle_request_channel($1,$2,$3,$4,$5,$6) AS id',[t.org,orphan,'Synthetic orphan QR','Synthetic unbound instance cleanup','TENANT',t.actor])).rows[0]!.id as string;
  const lease = randomUUID();
  await db.database.pool.query("UPDATE lifecycle_cleanup_items SET status='DONE' WHERE deletion_id=$1",[d]);
  await db.database.pool.query("UPDATE lifecycle_deletions SET status='CLEANING_EXTERNAL',lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[d,lease]);
  expect((await db.database.pool.query('SELECT kind,messaging_channel_id FROM lifecycle_deletions WHERE id=$1',[d])).rows).toEqual([{kind:'CHANNEL',messaging_channel_id:null}]);
  const before = {readyObject:await object(ready.objectId),unknownObject:await object(unknown.objectId),readyOperation:await operation(ready.objectId),unknownOperation:await operation(unknown.objectId),
    media:(await db.database.pool.query('SELECT * FROM messaging_media WHERE id=ANY($1::uuid[]) ORDER BY id',[[readyMedia,unknownMedia]])).rows};
  expect(await store.prepareCleanup(d,lease)).toBe(0);
  expect(await store.runCleanupOnce(d,lease)).toBe(false);
  expect((await db.database.pool.query("SELECT id FROM media_private_operations WHERE deletion_id=$1 AND kind='DELETE'",[d])).rows).toEqual([]);
  await purge({id:d,lease},'channel');
  expect((await db.database.pool.query('SELECT status FROM lifecycle_deletions WHERE id=$1',[d])).rows).toEqual([{status:'COMPLETED'}]);
  expect((await db.database.pool.query('SELECT id FROM instances WHERE id=$1',[orphan])).rows).toEqual([]);
  expect({readyObject:await object(ready.objectId),unknownObject:await object(unknown.objectId),readyOperation:await operation(ready.objectId),unknownOperation:await operation(unknown.objectId),
    media:(await db.database.pool.query('SELECT * FROM messaging_media WHERE id=ANY($1::uuid[]) ORDER BY id',[[readyMedia,unknownMedia]])).rows}).toEqual(before);
  expect(h.actions).toEqual(['PUT','PUT_UNKNOWN']);
  expect((await db.database.pool.query('SELECT id FROM messaging_channels WHERE id=$1',[t.channel])).rowCount).toBe(1);
});

it('runs trusted read authorization again after real actor revocation during object GET', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  const secondOwner = randomUUID();
  await db.database.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic-only')", [secondOwner, `${secondOwner}@example.test`]);
  await db.database.pool.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')", [t.org, secondOwner]);
  await store.dispatchPut(t.org, staged.objectId);
  const realRead = h.objectStore.read;
  h.objectStore.read = async (ref, expected, control) => {
    await db.database.pool.query("UPDATE memberships SET status='DISABLED' WHERE organization_id=$1 AND user_id=$2", [t.org, t.actor]);
    return realRead(ref, expected, control);
  };
  await expect(store.read(t.org, media, { authorize: async () => {
    const active = (await db.database.pool.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='ACTIVE'", [t.org, t.actor])).rowCount;
    if (!active) throw new Error('SYNTHETIC_READ_ACTOR_REVOKED');
  } })).rejects.toThrow('SYNTHETIC_READ_ACTOR_REVOKED');
});

it('binds the definer to the current organization and an existing channel without granting app lifecycle or organization UPDATE', async () => {
  const t = await tenant(), other = await tenant();
  await expect(db.transact(t.org, tx => tx.query('SELECT media_private_channel_open($1,$2)', [other.org, other.channel]))).rejects.toMatchObject({ code: '42501' });
  expect((await db.transact(t.org, tx => tx.query('SELECT media_private_channel_open($1,$2) AS open', [t.org, other.channel]))).rows).toEqual([{ open: false }]);
  expect((await db.database.pool.query("SELECT has_table_privilege('jrc_app','organizations','UPDATE') AS org_update,has_table_privilege('jrc_app','lifecycle_deletions','SELECT') AS lifecycle_read")).rows).toEqual([{ org_update: false, lifecycle_read: false }]);
});

it('enforces the media identity in a private-object FK instead of allowing same-channel aliasing', async () => {
  const t = await tenant(), a = await pending(t), b = await pending(t), h = transport(), store = core(h);
  const first = await store.stage(t.org, a, file), second = await store.stage(t.org, b, file);
  await expect(db.transact(t.org, async tx => {
    await tx.query('UPDATE messaging_media SET private_object_id=$2 WHERE id=$1', [a, second.objectId]);
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  })).rejects.toMatchObject({ code: '23503' });
  expect((await db.database.pool.query('SELECT private_object_id FROM messaging_media WHERE id=$1', [a])).rows).toEqual([{ private_object_id: first.objectId }]);
});

it('locks the cleanup object before its operation so a concurrent worker cannot invert that order', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), base = core(h), staged = await base.stage(t.org, media, file);
  await base.dispatchPut(t.org, staged.objectId); const d = await organizationDeletion(t); await base.prepareCleanup(d.id, d.lease);
  const store = core(h, 100, { cleanupTransact: work => withLifecycleWorkerTransaction(lifecycle, async tx => {
    const wrapped = { query: (async (...args: Parameters<typeof tx.query>) => {
      if (String(args[0]).includes('UPDATE media_private_operations SET state=$3')) {
        const contender = await db.database.pool.connect();
        try {
          await contender.query('BEGIN');
          await expect(contender.query('SELECT id FROM media_private_objects WHERE id=$1 FOR UPDATE NOWAIT', [staged.objectId])).rejects.toMatchObject({ code: '55P03' });
        } finally { await contender.query('ROLLBACK'); contender.release(); }
      }
      return tx.query(...args);
    }) as typeof tx.query };
    return work(wrapped);
  }) });
  await store.runCleanupOnce(d.id, d.lease);
  expect((await operation(staged.objectId, 'DELETE')).state).toBe('CONFIRMED');
});

it('keeps pending private media safely retriable for existing readers without mutating the object', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  await store.stage(t.org, media, file);
  await expect(store.read(t.org, media)).rejects.toMatchObject({ code: 'MEDIA_NOT_READY', retrySafe: true });
  expect(h.actions).toEqual([]);
});

it('commits expired DELETE recovery before locking its object and inspects instead of replaying', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), base = core(h), staged = await base.stage(t.org, media, file);
  await base.dispatchPut(t.org, staged.objectId); const d = await organizationDeletion(t); await base.prepareCleanup(d.id, d.lease);
  await db.database.pool.query(`UPDATE media_private_operations SET state='DISPATCHED',dispatched_at=clock_timestamp()-interval '2 minutes',
    lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 second' WHERE object_id=$1 AND kind='DELETE'`, [staged.objectId, randomUUID()]);
  const deleteId = (await operation(staged.objectId, 'DELETE')).id;
  const store = core(h, 100, { cleanupTransact: work => withLifecycleWorkerTransaction(lifecycle, async tx => {
    const wrapped = { query: (async (...args: Parameters<typeof tx.query>) => {
      if (String(args[0]).includes('SELECT * FROM media_private_objects WHERE id=$1 FOR UPDATE')) {
        const contender = await db.database.pool.connect();
        try {
          await contender.query('BEGIN');
          const unlocked = await contender.query('SELECT id FROM media_private_operations WHERE id=$1 FOR UPDATE NOWAIT', [deleteId]);
          expect(unlocked.rowCount).toBe(1);
        } finally { await contender.query('ROLLBACK'); contender.release(); }
      }
      return tx.query(...args);
    }) as typeof tx.query };
    return work(wrapped);
  }) });
  await store.runCleanupOnce(d.id, d.lease);
  expect((await operation(staged.objectId, 'DELETE')).state).toBe('UNKNOWN');
  expect(h.actions).toEqual(['PUT', 'INSPECT']);
});

it('rejects admission in a SUSPENDED tenant before staging or reserving private media', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [t.org]);
  await expect(store.stage(t.org, media, file)).rejects.toThrow('RESOURCE_DELETING');
  expect((await db.database.pool.query('SELECT id FROM media_private_objects WHERE organization_id=$1', [t.org])).rows).toEqual([]);
  expect((await db.database.pool.query('SELECT status,storage_backend,private_object_id FROM messaging_media WHERE id=$1', [media])).rows).toEqual([
    { status: 'PENDING', storage_backend: 'INLINE_V1', private_object_id: null },
  ]);
  expect(h.actions).toEqual([]);
});

it('cancels a PREPARED PUT after suspension without a new effect or uncertain result', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [t.org]);
  expect(await store.dispatchPut(t.org, staged.objectId)).toBe('REJECTED');
  expect(await operation(staged.objectId)).toMatchObject({ state: 'REJECTED', dispatched_at: null, lease_token: null });
  expect(await object(staged.objectId)).toMatchObject({ state: 'REJECTED', reserved_bytes: 0, staging_ciphertext: null });
  expect(h.actions).toEqual([]);
});

it.each(['SUSPENDED', 'DISABLED'] as const)('reconciles an existing UNKNOWN PUT for %s without admitting or replaying PUT', async status => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  h.objectStore.put = async (ref, bytes) => { h.actions.push('PUT'); h.bodies.set(ref.operationId, new Uint8Array(bytes)); return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; };
  const staged = await store.stage(t.org, media, file); await store.dispatchPut(t.org, staged.objectId);
  await db.database.pool.query('UPDATE organizations SET status=$2 WHERE id=$1', [t.org, status]);
  expect(await store.reconcilePut(t.org, staged.objectId)).toBe('CONFIRMED');
  expect(await operation(staged.objectId)).toMatchObject({ state: 'CONFIRMED', lease_token: null });
  expect(await object(staged.objectId)).toMatchObject({ state: 'READY', reserved_bytes: 5 });
  expect((await db.database.pool.query('SELECT status,last_error FROM messaging_media WHERE id=$1', [media])).rows).toEqual([
    { status: 'READY', last_error: null },
  ]);
  await expect(store.read(t.org, media)).rejects.toThrow('RESOURCE_DELETING');
  expect(h.actions).toEqual(['PUT', 'INSPECT']);
});

it('authorizes read before channel locks so lifecycle can take instance then channel without inversion', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  await store.dispatchPut(t.org, staged.objectId);
  await expect(store.read(t.org, media, { authorize: async tx => {
    const contender = await db.database.pool.connect();
    try {
      await contender.query('BEGIN');
      await contender.query('SELECT id FROM instances WHERE id=$1 FOR UPDATE', [t.instance]);
      expect((await contender.query('SELECT id FROM messaging_channels WHERE id=$1 FOR NO KEY UPDATE NOWAIT', [t.channel])).rowCount).toBe(1);
    } finally { await contender.query('ROLLBACK'); contender.release(); }
    // Actual lifecycle fence, after proving neither callback lock is inverted.
    await channelDeletion(t);
    await lockAttendanceChannel(tx as TenantTransaction, t.org, t.channel);
  } })).rejects.toThrow('RESOURCE_DELETING');
  expect(h.actions).toEqual(['PUT']);
});

it('schedules a PREPARED PUT despite an older UNKNOWN missing object without replaying the latter', async () => {
  const t = await tenant(), a = await pending(t), b = await pending(t), h = transport(), store = core(h);
  const originalPut = h.objectStore.put;
  let unknownId = '';
  h.objectStore.put = async (ref, bytes, expected, control) => {
    if (ref.operationId === unknownId) { h.actions.push('UNKNOWN_PUT'); return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; }
    return originalPut(ref, bytes, expected, control);
  };
  unknownId = (await store.stage(t.org, a, file)).objectId; await store.dispatchPut(t.org, unknownId);
  const next = await store.stage(t.org, b, file);
  await store.runOnce(t.org); await store.runOnce(t.org);
  expect((await operation(next.objectId)).state).toBe('CONFIRMED');
  expect((await operation(unknownId)).state).toBe('UNKNOWN');
  expect(h.actions).toEqual(['UNKNOWN_PUT', 'INSPECT', 'PUT']);
});

it('rejects DELETE authorization whose lease expires while the SQL trigger waits for its deletion lock', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  await store.dispatchPut(t.org, staged.objectId); const d = await organizationDeletion(t);
  const holder = await db.database.pool.connect(), actor = await lifecycle.connect();
  let pendingInsert: Promise<unknown> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query("UPDATE lifecycle_deletions SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1", [d.id]);
    await holder.query('COMMIT');
    await holder.query('BEGIN'); await holder.query('SELECT id FROM lifecycle_deletions WHERE id=$1 FOR UPDATE', [d.id]);
    await actor.query('BEGIN'); const pid = (await actor.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    pendingInsert = actor.query(`INSERT INTO media_private_operations(organization_id,channel_id,object_id,kind,deletion_id,authorization_lease)
      VALUES($1,$2,$3,'DELETE',$4,$5)`, [t.org, t.channel, staged.objectId, d.id, d.lease]).then(
        result => ({ result }), error => ({ error }),
      );
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      if ((await db.database.pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked', [(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid, pid])).rows[0]!.blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await holder.query('SELECT pg_sleep(1.1)'); await holder.query('COMMIT');
    expect(await pendingInsert).toMatchObject({ error: { code: '23514', message: 'LIFECYCLE_LEASE_LOST' } });
  } finally {
    await holder.query('ROLLBACK'); await actor.query('ROLLBACK'); await pendingInsert;
    holder.release(); actor.release();
  }
  expect(h.actions).toEqual(['PUT']);
});

it('bounds DELETE lease and adapter preflight to current lifecycle authorization without sending after expiry', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), base = core(h), staged = await base.stage(t.org, media, file);
  await base.dispatchPut(t.org, staged.objectId); const d = await organizationDeletion(t); await base.prepareCleanup(d.id, d.lease);
  const lifecycleExpiry = (await db.database.pool.query("UPDATE lifecycle_deletions SET lease_expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE id=$1 RETURNING lease_expires_at", [d.id])).rows[0]!.lease_expires_at as Date;
  const methods: string[] = [];
  const adapter = createS3PrivateObjectStore({ endpoint: 'https://objects.example.test', bucket: 'broker-private', profile: 'private-v1',
    region: 'us-east-1', accessKeyId: 'SYNTHETICACCESS', secretAccessKey: 'synthetic-only', dedicatedBucket: true, requestTimeoutMs: 5_000,
    fetch: async (input, init) => {
      methods.push(init?.method ?? 'GET'); const query = new URL(String(input)).search;
      if (query === '?versioning=') {
        // Synthetic transport ignores abort; the real adapter must still stop at
        // the lifecycle deadline before it can reach its mutating request.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, lifecycleExpiry.getTime() - Date.now()) + 50));
        return new Response('<VersioningConfiguration/>');
      }
      if (query === '?object-lock=') return new Response('<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>', { status: 404 });
      if (query === '?policy=') return new Response('<Error><Code>NoSuchBucketPolicy</Code></Error>', { status: 404 });
      if (query === '?acl=') return new Response('<AccessControlPolicy><Owner><ID>synthetic-owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>synthetic-owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>');
      return new Response(null, { status: 204 });
    },
  });
  let operationExpiry: Date | undefined, deadline: Date | undefined;
  h.objectStore.remove = async (ref, control) => {
    operationExpiry = (await operation(ref.operationId, 'DELETE')).lease_expires_at as Date; deadline = control.deadline;
    return adapter.remove(ref, control);
  };
  const store = core(h, 100, { requestTimeoutMs: 5_000 });
  await store.runCleanupOnce(d.id, d.lease).catch(error => expect(error.message).toBe('LIFECYCLE_LEASE_LOST'));
  expect(operationExpiry!.getTime()).toBeLessThanOrEqual(lifecycleExpiry.getTime());
  expect(deadline!.getTime()).toBeLessThanOrEqual(lifecycleExpiry.getTime());
  expect(methods).toEqual(['GET']);
  expect(await operation(staged.objectId, 'DELETE')).toMatchObject({ state: 'UNKNOWN', lease_token: null });
  expect((await object(staged.objectId)).reserved_bytes).toBe(5);
});

it('restores read after UNKNOWN reconciliation during suspension and reactivation without another PUT', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h);
  h.objectStore.put = async (ref, bytes) => { h.actions.push('PUT'); h.bodies.set(ref.operationId, new Uint8Array(bytes)); return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; };
  const staged = await store.stage(t.org, media, file); await store.dispatchPut(t.org, staged.objectId);
  await db.database.pool.query("UPDATE organizations SET status='SUSPENDED' WHERE id=$1", [t.org]);
  await store.reconcilePut(t.org, staged.objectId);
  await expect(store.read(t.org, media)).rejects.toThrow('RESOURCE_DELETING');
  await db.database.pool.query("UPDATE organizations SET status='ACTIVE' WHERE id=$1", [t.org]);
  expect(await store.read(t.org, media)).toEqual(file);
  expect(h.actions).toEqual(['PUT', 'INSPECT', 'GET']);
});

it('persists and freezes the adapter-derived destination fingerprint for each new object', async () => {
  const t = await tenant(), media = await pending(t), h = transport(), store = core(h), staged = await store.stage(t.org, media, file);
  expect((await object(staged.objectId)).destination_fingerprint).toBe(h.objectStore.destinationFingerprint);
  await expect(db.transact(t.org, tx => tx.query("UPDATE media_private_objects SET destination_fingerprint=$2 WHERE id=$1", [staged.objectId, 'b'.repeat(64)]))).rejects.toMatchObject({ code: '23514' });
  const newMedia = await pending(t);
  await expect(db.transact(t.org, tx => tx.query(`INSERT INTO media_private_objects(id,organization_id,channel_id,media_id,profile,destination_fingerprint,
    plain_byte_size,plain_sha256,cipher_byte_length,cipher_sha256,mime_type,kind,file_name,staging_ciphertext,reserved_bytes)
    SELECT gen_random_uuid(),organization_id,channel_id,$2,profile,'invalid',plain_byte_size,plain_sha256,cipher_byte_length,cipher_sha256,mime_type,kind,file_name,staging_ciphertext,reserved_bytes
    FROM media_private_objects WHERE id=$1`, [staged.objectId, newMedia]))).rejects.toMatchObject({ code: '23514' });
});

it('rejects a trusted object-store port without a valid destination fingerprint before database work', () => {
  const h = transport();
  expect(() => core(h, 100, { objectStore: { ...h.objectStore, destinationFingerprint: 'invalid' } as PrivateObjectStore })).toThrow('MEDIA_INVALID_CONFIG');
});

it('rejects stage idempotence and PREPARED PUT for a changed physical destination before I/O or quota release', async () => {
  const t = await tenant(), media = await pending(t), a = transport(), original = core(a), staged = await original.stage(t.org, media, file);
  const b = transport({ ...destinationConfig, bucket: 'other-private' }), changed = core(b);
  await expect(changed.stage(t.org, media, file)).rejects.toThrow('MEDIA_OBJECT_DESTINATION_MISMATCH');
  await expect(changed.dispatchPut(t.org, staged.objectId)).rejects.toThrow('MEDIA_OBJECT_DESTINATION_MISMATCH');
  expect(await operation(staged.objectId)).toMatchObject({ state: 'PREPARED', dispatched_at: null, lease_token: null });
  expect((await object(staged.objectId)).reserved_bytes).toBe(5); expect(b.actions).toEqual([]);
});

it('preserves UNKNOWN and quota when another destination would inspect a missing object', async () => {
  const t = await tenant(), media = await pending(t), a = transport(), original = core(a);
  a.objectStore.put = async () => ({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  const staged = await original.stage(t.org, media, file); await original.dispatchPut(t.org, staged.objectId);
  const b = transport({ ...destinationConfig, endpoint: 'https://different.example.test/' });
  await expect(core(b).reconcilePut(t.org, staged.objectId)).rejects.toThrow('MEDIA_OBJECT_DESTINATION_MISMATCH');
  expect(await operation(staged.objectId)).toMatchObject({ state: 'UNKNOWN', lease_token: null });
  expect((await object(staged.objectId)).reserved_bytes).toBe(5); expect(b.actions).toEqual([]);
});

it('blocks GET for a confirmed object when region or destination changes before returning plaintext', async () => {
  const t = await tenant(), media = await pending(t), a = transport(), original = core(a), staged = await original.stage(t.org, media, file);
  await original.dispatchPut(t.org, staged.objectId);
  const b = transport({ ...destinationConfig, region: 'eu-west-1' });
  await expect(core(b).read(t.org, media)).rejects.toThrow('MEDIA_OBJECT_DESTINATION_MISMATCH');
  expect((await operation(staged.objectId)).state).toBe('CONFIRMED'); expect(b.actions).toEqual([]);
});

it('blocks DELETE preparation and UNKNOWN absence inspection against a changed destination', async () => {
  const t = await tenant(), media = await pending(t), a = transport(), original = core(a), staged = await original.stage(t.org, media, file);
  await original.dispatchPut(t.org, staged.objectId); const d = await organizationDeletion(t);
  const b = transport({ ...destinationConfig, bucket: 'other-private' }), changed = core(b);
  await expect(changed.prepareCleanup(d.id, d.lease)).rejects.toThrow('MEDIA_OBJECT_DESTINATION_MISMATCH');
  await original.prepareCleanup(d.id, d.lease);
  await expect(changed.runCleanupOnce(d.id, d.lease)).rejects.toThrow('MEDIA_OBJECT_DESTINATION_MISMATCH');
  expect((await operation(staged.objectId, 'DELETE')).state).toBe('PREPARED');
  a.objectStore.remove = async () => ({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  await original.runCleanupOnce(d.id, d.lease);
  await expect(changed.runCleanupOnce(d.id, d.lease)).rejects.toThrow('MEDIA_OBJECT_DESTINATION_MISMATCH');
  expect((await operation(staged.objectId, 'DELETE')).state).toBe('UNKNOWN');
  expect((await object(staged.objectId)).reserved_bytes).toBe(5); expect(b.actions).toEqual([]);
});
