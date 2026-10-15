import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MediaError,
  safeMediaName,
  validateMedia,
  validateUploadMedia,
  type BinaryMedia,
  type MediaKind,
} from "@jrc/providers";
import type {
  TenantTransaction,
  OrganizationTransaction,
} from "../../db/tenant-transaction.js";
import { createIntegrationSecrets } from "../integrations/secrets.js";
import type { DurablePrivateMediaStore, PrivateMediaReadControl } from "./durable-private-media.js";
const descriptor = z.discriminatedUnion("source", [
  z.object({source:z.literal('UPLOAD'),descriptor:z.strictObject({rootAutomationId:z.uuid(),idempotencyKey:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)})}),
  z.object({
    source: z.literal("QR"),
    descriptor: z.strictObject({ messageId: z.string().min(1).max(256) }),
  }),
  z.object({
    source: z.literal("META"),
    descriptor: z.strictObject({
      mediaId: z.string().regex(/^[1-9]\d{4,63}$/),
    }),
  }),
  z.object({
    source: z.literal("CHATWOOT"),
    descriptor: z.strictObject({
      integrationId: z.uuid(),
      conversationId: z.number().int().positive(),
      messageId: z.number().int().positive(),
      attachmentId: z.number().int().positive(),
    }),
  }),
]);
export interface MediaAsset {
  id: string;
  organization_id: string;
  channel_id: string;
  source: "QR" | "META" | "CHATWOOT" | "UPLOAD";
  source_key: string;
  kind: MediaKind;
  file_name: string;
  descriptor: Record<string, unknown>;
  status: string;
  attempts: number;
  lease_token: string;
  last_error: string | null;
}
export interface MediaRegistration {
  source: MediaAsset["source"];
  sourceKey: string;
  kind: MediaKind;
  fileName: string;
  descriptor: Record<string, unknown>;
}
export async function registerPendingMedia(
  tx: TenantTransaction,
  org: string,
  channel: string,
  input: MediaRegistration,
): Promise<string> {
  const parsed = descriptor.parse(input);
  const sourceKey = z.string().min(1).max(512).parse(input.sourceKey);
  const kind = z
    .enum(["image", "audio", "video", "document", "sticker"])
    .parse(input.kind);
  const row = (
    await tx.query<{ id: string }>(
      `INSERT INTO messaging_media(organization_id,channel_id,source,source_key,kind,file_name,descriptor) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
 ON CONFLICT(organization_id,channel_id,source,source_key) DO UPDATE SET source_key=messaging_media.source_key RETURNING id`,
      [
        org,
        channel,
        parsed.source,
        sourceKey,
        kind,
        safeMediaName(input.fileName),
        JSON.stringify(parsed.descriptor),
      ],
    )
  ).rows[0];
  return row!.id;
}
export interface MediaStoreOptions {
  encryptionKey: string;
  maxStorageBytes?: number;
  transact<T>(org: string, op: OrganizationTransaction<T>): Promise<T>;
  download(asset: MediaAsset): Promise<BinaryMedia>;
  /** Trusted server port; use the same logical quota as this facade. */
  privateStore?: Pick<DurablePrivateMediaStore, "stage" | "dispatchPut" | "runOnce" | "read">;
}
export function createMediaStore(options: MediaStoreOptions) {
  const vault = createIntegrationSecrets(options.encryptionKey),
    tx = options.transact,
    privateStore = options.privateStore;
  const maximum = z
    .number()
    .int()
    .positive()
    .max(1_099_511_627_776)
    .parse(options.maxStorageBytes ?? 1_073_741_824);
  return {
    async writeUpload(org:string,channel:string,identity:{rootAutomationId:string;idempotencyKey:string},input:BinaryMedia,control?:PrivateMediaReadControl):Promise<string>{
      const file={...input,bytes:new Uint8Array(input.bytes),fileName:safeMediaName(input.fileName)};validateUploadMedia(file);
      const sha256=createHash('sha256').update(file.bytes).digest('hex'),sourceKey=`${identity.rootAutomationId}:${identity.idempotencyKey}`;
      const uploadDescriptor={...identity,sha256};descriptor.parse({source:'UPLOAD',descriptor:uploadDescriptor});
      const id=await tx(org,async t=>{
        await control?.authorize?.(t);
        if(!(await t.query<{open:boolean}>('select media_private_channel_open($1,$2) as open',[org,channel])).rows[0]?.open)throw new MediaError('RESOURCE_DELETING');
        const id=await registerPendingMedia(t,org,channel,{source:'UPLOAD',sourceKey,kind:file.kind,fileName:file.fileName,descriptor:uploadDescriptor});
        const existing=(await t.query<MediaAsset>('select * from messaging_media where organization_id=$1 and id=$2',[org,id])).rows[0];
        if(!existing||JSON.stringify(existing.descriptor)!==JSON.stringify(uploadDescriptor)&&existing.descriptor.sha256!==sha256||existing.kind!==file.kind||existing.file_name!==file.fileName)throw new MediaError('MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT');
        return id;
      });
      if(privateStore){
        const ready=await tx(org,async t=>{await control?.authorize?.(t);return (await t.query<{status:string;sha256:string;mime_type:string}>('select status,sha256,mime_type from messaging_media where organization_id=$1 and id=$2',[org,id])).rows[0];});
        if(ready?.status==='READY'){if(ready.sha256!==sha256||ready.mime_type!==file.mimeType)throw new MediaError('MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT');return id;}
        const staged=await privateStore.stage(org,id,file,{...(control?.authorize?{authorize:control.authorize}:{})});await privateStore.dispatchPut(org,staged.objectId);
        await tx(org,async t=>{await control?.authorize?.(t);});return id;
      }
      await tx(org,async t=>{
        await control?.authorize?.(t);
        if(!(await t.query<{open:boolean}>('select media_private_channel_open($1,$2) as open',[org,channel])).rows[0]?.open)throw new MediaError('RESOURCE_DELETING');
        await t.query("select pg_advisory_xact_lock(hashtextextended('media-storage:'||$1,0))",[org]);
        const existing=(await t.query<{status:string;sha256:string;mime_type:string}>('select status,sha256,mime_type from messaging_media where organization_id=$1 and id=$2 for update',[org,id])).rows[0];
        if(existing?.status==='READY'){if(existing.sha256!==sha256||existing.mime_type!==file.mimeType)throw new MediaError('MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT');return;}
        const used=Number((await t.query<{bytes:string}>(`select coalesce((select sum(byte_size) from messaging_media where organization_id=$1 and storage_backend='INLINE_V1'),0)+coalesce((select sum(reserved_bytes) from media_private_objects where organization_id=$1),0) as bytes`,[org])).rows[0]!.bytes);
        if(used+file.bytes.byteLength>maximum)throw new MediaError('MEDIA_STORAGE_LIMIT');
        const encrypted=vault.encrypt(`${org}:media:${id}`,Buffer.from(file.bytes).toString('base64'));
        await t.query(`update messaging_media set encrypted_data=$3,byte_size=$4,sha256=$5,mime_type=$6,status='READY',last_error=NULL,updated_at=now() where organization_id=$1 and id=$2 and source='UPLOAD' and status='PENDING'`,[org,id,encrypted,file.bytes.byteLength,sha256,file.mimeType]);
      });return id;
    },
    async read(org: string, id: string, control?: PrivateMediaReadControl): Promise<BinaryMedia> {
      if (privateStore) return privateStore.read(org, id, control);
      const row = await tx(
        org,
        async (t) => {
          await control?.authorize?.(t);
          return (
            await t.query<
              MediaAsset & {
                encrypted_data: string;
                mime_type: string;
                sha256: string;
                storage_backend: string;
                private_object_id: string | null;
              }
            >(
              "SELECT * FROM messaging_media WHERE organization_id=$1 AND id=$2",
              [org, id],
            )
          ).rows[0];
        },
      );
      if (!row) throw new MediaError("MEDIA_NOT_FOUND");
      if (row.storage_backend === "PRIVATE_OBJECT" || row.private_object_id)
        throw new MediaError("MEDIA_OBJECT_BACKEND_UNAVAILABLE", true);
      if (row.status !== "READY")
        throw new MediaError(
          row.status === "FAILED"
            ? (row.last_error ?? "MEDIA_DOWNLOAD_FAILED")
            : "MEDIA_NOT_READY",
          row.status !== "FAILED",
        );
      const bytes = new Uint8Array(
        Buffer.from(
          vault.decrypt(`${org}:media:${id}`, row.encrypted_data),
          "base64",
        ),
      );
      if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
        throw new MediaError("MEDIA_INTEGRITY_FAILED");
      if (control?.authorize) await tx(org, async t => { await control.authorize!(t); });
      return {
        bytes,
        mimeType: row.mime_type,
        fileName: row.file_name,
        kind: row.kind,
      };
    },
    async runOnce(org: string): Promise<void> {
      // Inspect/dispatch one durable private operation, then independently
      // service a pending download. UNKNOWN/MISSING does not starve ingress.
      await privateStore?.runOnce(org);
      const asset = await tx(org, async (t) => {
        if (privateStore && !(await t.query<{ active: boolean }>("SELECT tenant_is_active($1) AS active", [org])).rows[0]!.active) return;
        await t.query(
          "UPDATE messaging_media SET status='PENDING',lease_token=NULL,lease_expires_at=NULL WHERE organization_id=$1 AND storage_backend='INLINE_V1' AND private_object_id IS NULL AND status='DOWNLOADING' AND lease_expires_at<now()",
          [org],
        );
        const candidate = (
          await t.query<{ id: string }>(
            "SELECT id FROM messaging_media WHERE organization_id=$1 AND storage_backend='INLINE_V1' AND private_object_id IS NULL AND status='PENDING' AND source<>'UPLOAD' AND available_at<=now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
            [org],
          )
        ).rows[0];
        if (!candidate) return;
        return (
          await t.query<MediaAsset>(
            "UPDATE messaging_media SET status='DOWNLOADING',attempts=attempts+1,lease_token=$3,lease_expires_at=now()+interval '2 minutes',updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",
            [org, candidate.id, randomUUID()],
          )
        ).rows[0];
      });
      if (!asset) return;
      try {
        descriptor.parse(asset);
        const file = await options.download(asset);
        validateMedia(file);
        if (privateStore) {
          const staged = await privateStore.stage(org, asset.id, file, { downloadLeaseToken: asset.lease_token });
          await privateStore.dispatchPut(org, staged.objectId);
          return;
        }
        const encrypted = vault.encrypt(
          `${org}:media:${asset.id}`,
          Buffer.from(file.bytes).toString("base64"),
        );
        await tx(org, async (t) => {
          await t.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('media-storage:'||$1,0))",
            [org],
          );
          const used = Number(
            (
              await t.query<{ bytes: string }>(
                `SELECT coalesce((SELECT sum(byte_size) FROM messaging_media WHERE organization_id=$1 AND storage_backend='INLINE_V1'),0)
                 +coalesce((SELECT sum(reserved_bytes) FROM media_private_objects WHERE organization_id=$1),0) AS bytes`,
                [org],
              )
            ).rows[0]!.bytes,
          );
          if (used + file.bytes.length > maximum)
            throw new MediaError("MEDIA_STORAGE_LIMIT");
          await t.query(
            `UPDATE messaging_media SET encrypted_data=$4,byte_size=$5,sha256=$6,mime_type=$7,kind=$8,file_name=$9,status='READY',lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
       WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='DOWNLOADING'`,
            [
              org,
              asset.id,
              asset.lease_token,
              encrypted,
              file.bytes.length,
              createHash("sha256").update(file.bytes).digest("hex"),
              file.mimeType,
              file.kind,
              safeMediaName(file.fileName),
            ],
          );
        });
      } catch (error) {
        const retry =
          (!(error instanceof MediaError) || error.retrySafe) &&
          asset.attempts < 6;
        const code =
          error instanceof MediaError ? error.code : "MEDIA_DOWNLOAD_FAILED";
        await tx(org, (t) =>
          t.query(
            `UPDATE messaging_media SET status=$4,last_error=$5,lease_token=NULL,lease_expires_at=NULL,available_at=now()+($6*interval '1 second'),updated_at=now()
     WHERE organization_id=$1 AND id=$2 AND lease_token=$3 AND status='DOWNLOADING' AND storage_backend='INLINE_V1' AND private_object_id IS NULL`,
            [
              org,
              asset.id,
              asset.lease_token,
              retry ? "PENDING" : "FAILED",
              code,
              Math.min(300, 5 * 2 ** asset.attempts),
            ],
          ),
        );
      }
    },
    async retry(org: string, id: string) {
      await tx(org, (t) =>
        t.query(
          "UPDATE messaging_media SET status='PENDING',attempts=0,last_error=NULL,available_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='FAILED' AND storage_backend='INLINE_V1' AND private_object_id IS NULL",
          [org, id],
        ),
      );
    },
  };
}
export type MediaStore = ReturnType<typeof createMediaStore>;
