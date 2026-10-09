import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MediaError, safeMediaName, validateMedia, type BinaryMedia } from '@jrc/providers';
import { createIntegrationSecrets } from '../integrations/secrets.js';
import type { PrivateObjectStore, PrivateObjectRef, ObjectStoreControl, ExpectedCiphertext, ObjectStoreMutation } from './private-object-store.js';

type Tx = Pick<PoolClient, 'query'>;
export type PrivateMediaTransaction = <T>(organizationId: string, work: (tx: Tx) => Promise<T>) => Promise<T>;
export type PrivateMediaCleanupTransaction = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;
export type PrivateMediaOperationState = 'PREPARED' | 'DISPATCHED' | 'CONFIRMED' | 'UNKNOWN' | 'REJECTED';
export interface DurablePrivateMediaOptions {
  transact: PrivateMediaTransaction;
  cleanupTransact: PrivateMediaCleanupTransaction;
  objectStore: PrivateObjectStore;
  /** Stable destination profile; changing credentials must not change its bucket. */
  profile: string; encryptionKey: string; maxStorageBytes?: number; requestTimeoutMs?: number;
}
export interface PrivateMediaReadControl {
  deadline?: Date; signal?: AbortSignal;
  /** Trusted server authorization before/after I/O and before scope locks.
   * Row-locking callbacks must follow organization -> instance -> channel
   * (lockAttendanceChannel is compatible), never media/object/operation first.
   */
  authorize?: (tx: Tx) => Promise<void>;
}
export interface PrivateMediaStageControl {
  /** Required for DOWNLOADING; a stale downloader cannot consume a newer claim. */
  downloadLeaseToken?: string;
}
interface ObjectRow {
  id: string; organization_id: string; channel_id: string; media_id: string; profile: string; destination_fingerprint: string;
  plain_byte_size: number; plain_sha256: string; cipher_byte_length: number; cipher_sha256: string;
  mime_type: string; kind: BinaryMedia['kind']; file_name: string; staging_ciphertext: string | null;
  state: 'STAGED' | 'READY' | 'DELETING' | 'DELETED' | 'REJECTED'; reserved_bytes: number;
}
interface OperationRow {
  id: string; object_id: string; state: PrivateMediaOperationState; kind: 'PUT' | 'DELETE';
  lease_token: string | null; lease_expires_at: Date | null; dispatched_at: Date | null; revision: string;
}
interface MediaRow {
  id: string; organization_id: string; channel_id: string; status: string; storage_backend: string;
  private_object_id: string | null; encrypted_data: string | null; byte_size: number; sha256: string;
  mime_type: string; file_name: string; kind: BinaryMedia['kind']; updated_at: Date; last_error: string | null;
  lease_token: string | null; lease_expires_at: Date | null;
}
interface DeletionRow {
  id: string; organization_id: string; messaging_channel_id: string | null; kind: 'CHANNEL' | 'ORGANIZATION';
  status: string; lease_token: string | null; lease_expires_at: Date | null; actor_kind: string; actor_id: string;
}
type Claim = { object: ObjectRow; operation: OperationRow; token: string };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function invalid(code: string): never { throw new MediaError(code); }
const staticCode = (value: unknown, fallback: string) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value) ? value : fallback;

/** Candidate core only. It owns no caller URL/key, HTTP route, provider send or scheduler. */
export function createDurablePrivateMediaStore(options: DurablePrivateMediaOptions) {
  const profile = options.profile, timeout = options.requestTimeoutMs ?? 30_000;
  const objectStore = options.objectStore;
  const maximum = options.maxStorageBytes ?? 1_073_741_824;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(profile) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_099_511_627_776
    || !Number.isInteger(timeout) || timeout < 1 || timeout > 60_000
    || !/^[a-f0-9]{64}$/.test(objectStore.destinationFingerprint)) invalid('MEDIA_INVALID_CONFIG');
  const vault = createIntegrationSecrets(options.encryptionKey), transact = options.transact, cleanup = options.cleanupTransact;
  function ref(row: ObjectRow): PrivateObjectRef {
    if (row.profile !== profile) invalid('MEDIA_OBJECT_PROFILE_UNAVAILABLE');
    if (row.destination_fingerprint !== objectStore.destinationFingerprint) invalid('MEDIA_OBJECT_DESTINATION_MISMATCH');
    return { organizationId: row.organization_id, channelId: row.channel_id, mediaId: row.media_id, operationId: row.id };
  }
  const expected = (row: ObjectRow): ExpectedCiphertext => ({ byteLength: row.cipher_byte_length, sha256: row.cipher_sha256 });
  function control(lease?: Date | null, input?: PrivateMediaReadControl): ObjectStoreControl {
    return { deadline: new Date(Math.min(Date.now() + timeout, lease ? lease.getTime() - 500 : Infinity,
      input?.deadline?.getTime() ?? Infinity)), ...(input?.signal ? { signal: input.signal } : {}) };
  }
  async function scope(tx: Tx, org: string, channel: string): Promise<boolean> {
    return (await tx.query<{ open: boolean }>('SELECT media_private_channel_open($1,$2) AS open', [org, channel])).rows[0]!.open;
  }
  async function getObject(tx: Tx, org: string, id: string, lock = false): Promise<ObjectRow> {
    const row = (await tx.query<ObjectRow>('SELECT * FROM media_private_objects WHERE organization_id=$1 AND id=$2' + (lock ? ' FOR UPDATE' : ''), [org, id])).rows[0];
    if (!row) invalid('MEDIA_NOT_FOUND'); return row;
  }
  async function lockObject(tx: Tx, org: string, id: string) {
    const peek = await getObject(tx, org, id), live = await scope(tx, org, peek.channel_id);
    await tx.query('SELECT id FROM messaging_media WHERE organization_id=$1 AND id=$2 FOR UPDATE', [org, peek.media_id]);
    return { object: await getObject(tx, org, id, true), live };
  }
  async function getOperation(tx: Tx, id: string, kind: 'PUT' | 'DELETE', lock = false) {
    return (await tx.query<OperationRow>('SELECT * FROM media_private_operations WHERE object_id=$1 AND kind=$2' + (lock ? ' FOR UPDATE' : ''), [id, kind])).rows[0];
  }
  async function failPrepared(tx: Tx, row: ObjectRow, code: string) {
    await tx.query("UPDATE media_private_operations SET state='REJECTED',last_error_code=$2,revision=revision+1,updated_at=now() WHERE object_id=$1 AND kind='PUT' AND state='PREPARED'", [row.id, code]);
    await tx.query("UPDATE media_private_objects SET state='REJECTED',staging_ciphertext=NULL,reserved_bytes=0,updated_at=now() WHERE id=$1", [row.id]);
    await tx.query("UPDATE messaging_media SET status='FAILED',last_error=$2,updated_at=now() WHERE organization_id=$1 AND private_object_id=$3", [row.organization_id, code, row.id]);
  }
  async function stage(org: string, mediaId: string, input: BinaryMedia, inputControl?: PrivateMediaStageControl): Promise<{ objectId: string; state: string }> {
    const file = { ...input, bytes: new Uint8Array(input.bytes) }; validateMedia(file);
    const size = file.bytes.byteLength, digest = hash(file.bytes), name = safeMediaName(file.fileName);
    const ciphertext = vault.encrypt(`${org}:media:${mediaId}`, Buffer.from(file.bytes).toString('base64'));
    const cipher = new Uint8Array(Buffer.from(ciphertext, 'utf8'));
    return transact(org, async tx => {
      const peek = (await tx.query<MediaRow>('SELECT * FROM messaging_media WHERE organization_id=$1 AND id=$2', [org, mediaId])).rows[0];
      if (!peek) invalid('MEDIA_NOT_FOUND'); if (!await scope(tx, org, peek.channel_id)) invalid('RESOURCE_DELETING');
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('media-storage:'||$1,0))", [org]);
      const media = (await tx.query<MediaRow>('SELECT * FROM messaging_media WHERE organization_id=$1 AND id=$2 FOR UPDATE', [org, mediaId])).rows[0]!;
      if (media.status === 'DOWNLOADING') {
        // LockRows may wait after projecting an expression. Query the real SQL
        // clock separately once the current media row is already locked.
        const current = (await tx.query<{ live: boolean }>('SELECT lease_expires_at>clock_timestamp() AS live FROM messaging_media WHERE organization_id=$1 AND id=$2', [org, mediaId])).rows[0]?.live;
        if (!inputControl?.downloadLeaseToken || media.lease_token !== inputControl.downloadLeaseToken || current !== true) invalid('MEDIA_LEASE_LOST');
      }
      if (media.private_object_id) {
        const existing = await getObject(tx, org, media.private_object_id, true);
        ref(existing);
        if (existing.profile !== profile || existing.plain_byte_size !== size || existing.plain_sha256 !== digest
          || existing.mime_type !== file.mimeType || existing.kind !== file.kind || existing.file_name !== name) invalid('MEDIA_OBJECT_CONFLICT');
        return { objectId: existing.id, state: existing.state };
      }
      if (media.status === 'READY') invalid('MEDIA_ALREADY_READY');
      const used = Number((await tx.query<{ bytes: string }>(`SELECT
        coalesce((SELECT sum(byte_size) FROM messaging_media WHERE organization_id=$1 AND storage_backend='INLINE_V1'),0)
        +coalesce((SELECT sum(reserved_bytes) FROM media_private_objects WHERE organization_id=$1),0) AS bytes`, [org])).rows[0]!.bytes);
      if (used + size > maximum) invalid('MEDIA_STORAGE_LIMIT');
      const id = randomUUID();
      await tx.query(`INSERT INTO media_private_objects(id,organization_id,channel_id,media_id,profile,destination_fingerprint,plain_byte_size,plain_sha256,cipher_byte_length,cipher_sha256,mime_type,kind,file_name,staging_ciphertext,reserved_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$7)`, [id, org, media.channel_id, mediaId, profile, objectStore.destinationFingerprint, size, digest, cipher.byteLength, hash(cipher), file.mimeType, file.kind, name, ciphertext]);
      await tx.query("INSERT INTO media_private_operations(id,organization_id,channel_id,object_id,kind) VALUES($1,$2,$3,$1,'PUT')", [id, org, media.channel_id]);
      await tx.query(`UPDATE messaging_media SET storage_backend='PRIVATE_OBJECT',private_object_id=$3,status='STORING',encrypted_data=NULL,
        byte_size=$4,sha256=$5,mime_type=$6,kind=$7,file_name=$8,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
        WHERE organization_id=$1 AND id=$2`, [org, mediaId, id, size, digest, file.mimeType, file.kind, name]);
      return { objectId: id, state: 'STAGED' };
    });
  }
  async function finishPut(org: string, claim: Claim, outcome: 'CONFIRMED' | 'UNKNOWN' | 'REJECTED', code: string | null): Promise<PrivateMediaOperationState> {
    return transact(org, async tx => {
      const { object } = await lockObject(tx, org, claim.object.id);
      const updated = await tx.query(`UPDATE media_private_operations SET state=$3,last_error_code=$4,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 AND lease_token=$2 AND state IN ('DISPATCHED','UNKNOWN') RETURNING id`, [claim.operation.id, claim.token, outcome, code]);
      if (!updated.rowCount) return (await getOperation(tx, object.id, 'PUT'))!.state;
      if (outcome === 'CONFIRMED') {
        await tx.query("UPDATE media_private_objects SET state='READY',staging_ciphertext=NULL,updated_at=now() WHERE id=$1", [object.id]);
        // READY records verified bytes; ACTIVE/lifecycle gates independently
        // authorize read. Suspension must not irreversibly destroy availability.
        await tx.query("UPDATE messaging_media SET status='READY',last_error=NULL,updated_at=now() WHERE organization_id=$1 AND private_object_id=$2", [org, object.id]);
      } else if (outcome === 'REJECTED') {
        await tx.query("UPDATE media_private_objects SET state='REJECTED',staging_ciphertext=NULL,reserved_bytes=0,updated_at=now() WHERE id=$1", [object.id]);
        await tx.query("UPDATE messaging_media SET status='FAILED',last_error=$3,updated_at=now() WHERE organization_id=$1 AND private_object_id=$2", [org, object.id, code]);
      }
      return outcome;
    });
  }
  async function dispatchPut(org: string, id: string): Promise<PrivateMediaOperationState> {
    const claimed: Claim | { state: PrivateMediaOperationState } = await transact(org, async tx => {
      const { object, live } = await lockObject(tx, org, id), op = await getOperation(tx, id, 'PUT', true);
      if (!op) invalid('MEDIA_NOT_FOUND'); if (op.state !== 'PREPARED') return { state: op.state };
      if (!live) { await failPrepared(tx, object, 'RESOURCE_DELETING'); return { state: 'REJECTED' as const }; }
      ref(object); const token = randomUUID();
      const operation = (await tx.query<OperationRow>(`UPDATE media_private_operations SET state='DISPATCHED',dispatched_at=clock_timestamp(),
        lease_token=$2,lease_expires_at=clock_timestamp()+($3*interval '1 millisecond'),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [op.id, token, timeout + 1_000])).rows[0]!;
      return { object, operation, token };
    });
    if ('state' in claimed) return claimed.state;
    let result: ObjectStoreMutation;
    try { result = await objectStore.put(ref(claimed.object), new Uint8Array(Buffer.from(claimed.object.staging_ciphertext!, 'utf8')), expected(claimed.object), control(claimed.operation.lease_expires_at)); }
    catch { result = { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' }; }
    const outcome = result.outcome === 'REJECTED' && result.code === 'OBJECT_CONFLICT' ? 'UNKNOWN' : result.outcome;
    return finishPut(org, claimed, outcome, result.outcome === 'CONFIRMED' ? null : staticCode(result.code, 'MEDIA_OBJECT_REQUEST_UNVERIFIED'));
  }
  async function recoverExpired(org: string): Promise<number> {
    return transact(org, async tx => (await tx.query(`UPDATE media_private_operations SET state='UNKNOWN',last_error_code='MEDIA_OBJECT_LEASE_EXPIRED',
      lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND kind='PUT'
       AND state IN ('DISPATCHED','UNKNOWN') AND lease_expires_at<clock_timestamp()`, [org])).rowCount ?? 0);
  }
  async function reconcilePut(org: string, id: string): Promise<PrivateMediaOperationState> {
    await recoverExpired(org);
    const claimed: Claim | { state: PrivateMediaOperationState } = await transact(org, async tx => {
      const { object } = await lockObject(tx, org, id), op = await getOperation(tx, id, 'PUT', true);
      if (!op) invalid('MEDIA_NOT_FOUND');
      if (op.state !== 'UNKNOWN' || op.lease_token) return { state: op.state };
      ref(object); const token = randomUUID();
      const operation = (await tx.query<OperationRow>(`UPDATE media_private_operations SET lease_token=$2,lease_expires_at=clock_timestamp()+($3*interval '1 millisecond'),
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [op.id, token, timeout + 1_000])).rows[0]!;
      return { object, operation, token };
    });
    if ('state' in claimed) return claimed.state;
    try {
      const result = await objectStore.inspect(ref(claimed.object), expected(claimed.object), control(claimed.operation.lease_expires_at));
      if (result.outcome === 'CONFIRMED') {
        if (result.byteLength === claimed.object.cipher_byte_length && result.sha256 === claimed.object.cipher_sha256)
          return finishPut(org, claimed, 'CONFIRMED', null);
        return finishPut(org, claimed, 'UNKNOWN', 'MEDIA_OBJECT_INTEGRITY_FAILED');
      }
      return finishPut(org, claimed, 'UNKNOWN', result.outcome === 'MISSING' ? 'MEDIA_OBJECT_NOT_OBSERVED' : staticCode(result.code, 'MEDIA_OBJECT_REQUEST_UNVERIFIED'));
    } catch { return finishPut(org, claimed, 'UNKNOWN', 'MEDIA_OBJECT_REQUEST_UNVERIFIED'); }
  }
  async function read(org: string, id: string, input?: PrivateMediaReadControl): Promise<BinaryMedia> {
    const snapshot = await transact(org, async tx => {
      const media = (await tx.query<MediaRow>('SELECT * FROM messaging_media WHERE organization_id=$1 AND id=$2', [org, id])).rows[0];
      if (!media) invalid('MEDIA_NOT_FOUND'); await input?.authorize?.(tx);
      if (!await scope(tx, org, media.channel_id)) invalid('RESOURCE_DELETING');
      if (media.status !== 'READY') throw new MediaError(media.status === 'FAILED' ? media.last_error ?? 'MEDIA_DOWNLOAD_FAILED' : 'MEDIA_NOT_READY', media.status !== 'FAILED');
      return { media, object: media.private_object_id ? await getObject(tx, org, media.private_object_id) : undefined };
    });
    let envelope = snapshot.media.encrypted_data;
    if (snapshot.object) {
      if (snapshot.object.state !== 'READY') invalid('MEDIA_NOT_READY');
      const result = await objectStore.read(ref(snapshot.object), expected(snapshot.object), control(undefined, input));
      if (result.outcome !== 'CONFIRMED') invalid(result.outcome === 'MISSING' ? 'MEDIA_OBJECT_MISSING' : staticCode(result.code, 'MEDIA_OBJECT_REQUEST_UNVERIFIED'));
      if (result.bytes.byteLength !== snapshot.object.cipher_byte_length || hash(result.bytes) !== snapshot.object.cipher_sha256) invalid('MEDIA_INTEGRITY_FAILED');
      envelope = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
    }
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(Buffer.from(vault.decrypt(`${org}:media:${id}`, envelope!), 'base64')); }
    catch { return invalid('MEDIA_INTEGRITY_FAILED'); }
    if (bytes.byteLength !== snapshot.media.byte_size || hash(bytes) !== snapshot.media.sha256) invalid('MEDIA_INTEGRITY_FAILED');
    await transact(org, async tx => {
      await input?.authorize?.(tx); if (!await scope(tx, org, snapshot.media.channel_id)) invalid('RESOURCE_DELETING');
      const current = (await tx.query<MediaRow>('SELECT * FROM messaging_media WHERE organization_id=$1 AND id=$2', [org, id])).rows[0];
      if (!current || current.status !== 'READY' || current.private_object_id !== snapshot.media.private_object_id
        || current.sha256 !== snapshot.media.sha256 || current.byte_size !== snapshot.media.byte_size) invalid('MEDIA_CONTEXT_CHANGED');
    });
    return { bytes, mimeType: snapshot.media.mime_type, kind: snapshot.media.kind, fileName: snapshot.media.file_name };
  }
  async function runOnce(org: string): Promise<boolean> {
    await recoverExpired(org);
    const op = await transact(org, async tx => (await tx.query<{ object_id: string; state: string }>(`SELECT object_id,state FROM media_private_operations
      WHERE organization_id=$1 AND kind='PUT' AND state IN ('PREPARED','UNKNOWN') AND lease_token IS NULL
      -- Every inspection/dispatch persists updated_at, rotating unresolved work
      -- behind older PREPARED rows without giving it permission to replay PUT.
      ORDER BY updated_at,id LIMIT 1`, [org])).rows[0]);
    if (!op) return false;
    if (op.state === 'UNKNOWN') await reconcilePut(org, op.object_id); else await dispatchPut(org, op.object_id);
    return true;
  }
  async function deletion(tx: Tx, id: string, lease: string): Promise<DeletionRow> {
    const identity = (await tx.query<{ current_user: string; session_user: string }>('SELECT current_user,session_user')).rows[0];
    if (identity?.current_user !== 'jrc_lifecycle' || identity.session_user !== 'jrc_lifecycle') invalid('LIFECYCLE_FORBIDDEN');
    const d = (await tx.query<DeletionRow>('SELECT * FROM lifecycle_deletions WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!d || d.lease_token !== lease || !['CLEANING_EXTERNAL','REMOVING_DATA'].includes(d.status)) invalid('LIFECYCLE_LEASE_LOST');
    const current = (await tx.query<{ live: boolean }>('SELECT lease_expires_at>clock_timestamp() AS live FROM lifecycle_deletions WHERE id=$1 AND lease_token=$2', [id, lease])).rows[0]?.live;
    if (current !== true) invalid('LIFECYCLE_LEASE_LOST');
    const authorized = d.actor_kind === 'PLATFORM'
      ? (await tx.query("SELECT 1 FROM platform_users WHERE id=$1 AND active AND role='SUPER_ADMIN'", [d.actor_id])).rowCount
      : d.actor_kind === 'TENANT' && (await tx.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1
        AND m.user_id=$2 AND m.status='ACTIVE' AND u.status='ACTIVE' AND m.role IN ('OWNER','ADMIN')`, [d.organization_id, d.actor_id])).rowCount;
    if (!authorized) invalid('LIFECYCLE_ACTOR_REVOKED'); return d;
  }
  async function prepareCleanup(id: string, lease: string): Promise<number> {
    return cleanup(async tx => {
      const d = await deletion(tx, id, lease);
      // A QR instance can exist without a messaging channel. Only organization
      // deletion has organization-wide scope; an unbound instance owns no media.
      if (d.kind === 'CHANNEL' && d.messaging_channel_id === null) return 0;
      const rows = (await tx.query<ObjectRow>(`SELECT * FROM media_private_objects WHERE organization_id=$1
        AND($2::uuid IS NULL OR channel_id=$2) AND state='READY' ORDER BY id FOR UPDATE`, [d.organization_id, d.kind === 'CHANNEL' ? d.messaging_channel_id : null])).rows;
      let count = 0;
      for (const row of rows) {
        ref(row);
        const inserted = await tx.query(`INSERT INTO media_private_operations(organization_id,channel_id,object_id,kind,deletion_id,authorization_lease)
          VALUES($1,$2,$3,'DELETE',$4,$5) ON CONFLICT(object_id,kind) DO NOTHING`, [row.organization_id, row.channel_id, row.id, id, lease]);
        count += inserted.rowCount ?? 0;
        await tx.query("UPDATE media_private_objects SET state='DELETING',updated_at=now() WHERE id=$1", [row.id]);
      }
      return count;
    });
  }
  async function claimDelete(id: string, lease: string, objectId?: string): Promise<Claim | undefined> {
    // Expiry touches operations only. Commit before taking any object lock;
    // a late callback locks object then operation and must never meet the inverse.
    const scoped = await cleanup(async tx => {
      const d = await deletion(tx, id, lease);
      if (d.kind === 'CHANNEL' && d.messaging_channel_id === null) return false;
      await tx.query(`UPDATE media_private_operations SET state='UNKNOWN',last_error_code='MEDIA_OBJECT_LEASE_EXPIRED',lease_token=NULL,lease_expires_at=NULL,
        revision=revision+1,updated_at=now() WHERE deletion_id=$1 AND kind='DELETE' AND state IN ('DISPATCHED','UNKNOWN') AND lease_expires_at<clock_timestamp()`, [id]);
      return true;
    });
    if (!scoped) return;
    return cleanup(async tx => {
      const d = await deletion(tx, id, lease);
      if (d.kind === 'CHANNEL' && d.messaging_channel_id === null) return;
      const op = (await tx.query<OperationRow>(`SELECT * FROM media_private_operations WHERE deletion_id=$1 AND kind='DELETE'
        AND state IN ('PREPARED','UNKNOWN') AND lease_token IS NULL AND($2::uuid IS NULL OR object_id=$2) ORDER BY updated_at,id LIMIT 1`, [id, objectId ?? null])).rows[0];
      if (!op) return;
      const object = (await tx.query<ObjectRow>('SELECT * FROM media_private_objects WHERE id=$1 FOR UPDATE', [op.object_id])).rows[0]!;
      ref(object); await tx.query('SELECT id FROM media_private_operations WHERE id=$1 FOR UPDATE', [op.id]);
      const token = randomUUID();
      const operation = (await tx.query<OperationRow>(`WITH timing AS MATERIALIZED(SELECT clock_timestamp() AS started)
        UPDATE media_private_operations SET state=CASE WHEN state='PREPARED' THEN 'DISPATCHED' ELSE state END,
        dispatched_at=CASE WHEN state='PREPARED' THEN timing.started ELSE dispatched_at END,lease_token=$2,
        lease_expires_at=LEAST(timing.started+($3*interval '1 millisecond'),$4::timestamptz),revision=revision+1,updated_at=now()
        FROM timing WHERE id=$1 AND state IN ('PREPARED','UNKNOWN') AND lease_token IS NULL AND timing.started<$4::timestamptz
        RETURNING media_private_operations.*`, [op.id, token, timeout + 1_000, d.lease_expires_at])).rows[0];
      return operation ? { object, operation, token } : undefined;
    });
  }
  async function finishDelete(claim: Claim, absent: boolean, code: string | null): Promise<boolean> {
    return cleanup(async tx => {
      // Claims take object then operation; a late ACK must preserve that order.
      await tx.query('SELECT id FROM media_private_objects WHERE id=$1 FOR UPDATE', [claim.object.id]);
      const updated = await tx.query(`UPDATE media_private_operations SET state=$3,last_error_code=$4,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
        WHERE id=$1 AND lease_token=$2 AND state IN ('DISPATCHED','UNKNOWN') RETURNING object_id`, [claim.operation.id, claim.token, absent ? 'CONFIRMED' : 'UNKNOWN', code]);
      if (!updated.rowCount) return false;
      if (absent) await tx.query("UPDATE media_private_objects SET state='DELETED',reserved_bytes=0,updated_at=now() WHERE id=$1", [claim.object.id]);
      return true;
    });
  }
  async function inspectDelete(claim: Claim) {
    try {
      const result = await objectStore.inspect(ref(claim.object), expected(claim.object), control(claim.operation.lease_expires_at));
      await finishDelete(claim, result.outcome === 'MISSING', result.outcome === 'MISSING' ? null
        : result.outcome === 'CONFIRMED' ? 'MEDIA_OBJECT_STILL_PRESENT' : staticCode(result.code, 'MEDIA_OBJECT_REQUEST_UNVERIFIED'));
    } catch { await finishDelete(claim, false, 'MEDIA_OBJECT_REQUEST_UNVERIFIED'); }
  }
  async function runCleanupOnce(id: string, lease: string): Promise<boolean> {
    let claimed = await claimDelete(id, lease); if (!claimed) return false;
    if (claimed.operation.state === 'DISPATCHED') {
      let code = 'MEDIA_OBJECT_DELETE_UNVERIFIED';
      try {
        const result = await objectStore.remove(ref(claimed.object), control(claimed.operation.lease_expires_at));
        if (result.outcome !== 'CONFIRMED') code = staticCode(result.code, code);
      } catch { code = 'MEDIA_OBJECT_REQUEST_UNVERIFIED'; }
      if (!await finishDelete(claimed, false, code)) return true;
      claimed = await claimDelete(id, lease, claimed.object.id); if (!claimed) return true;
    }
    await inspectDelete(claimed); return true;
  }
  return Object.freeze({ stage, dispatchPut, reconcilePut, recoverExpired, read, runOnce, prepareCleanup, runCleanupOnce });
}
export type DurablePrivateMediaStore = ReturnType<typeof createDurablePrivateMediaStore>;
