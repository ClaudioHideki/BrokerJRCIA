import { randomUUID } from 'node:crypto';
import type { AutomationGraphV1 } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { assertMediaAsset, readMediaAsset } from '../automations/conversation-effects-repository.js';
import { hashIdempotencyRequest } from '../instances/idempotency.js';
import { setupFail } from './service.js';

/** Alias an already authorized immutable blob, keeping each definition's asset ownership. */
export async function prepareTestMedia(tx: TenantTransaction, org: string, sourceRoot: string, testRoot: string, graph: AutomationGraphV1) {
  const copy = structuredClone(graph);
  for (const node of copy.nodes.filter(node => node.type === 'media' && node.data.mediaEffectVersion === 2)) {
    const config = node.data as unknown as Parameters<typeof assertMediaAsset>[3], channel = String(node.data.channelId);
    const source = assertMediaAsset(org, sourceRoot, channel, config, await readMediaAsset(tx, org, config.mediaId, true));
    const requestHash = hashIdempotencyRequest({ sourceRoot, assetId: source.id, revision: source.revision, mediaId: source.mediaId, testRoot });
    await tx.query(`INSERT INTO automation_media_assets(organization_id,id,root_automation_id,channel_id,media_id,name,kind,idempotency_key,request_hash,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'READY') ON CONFLICT(organization_id,root_automation_id,channel_id,idempotency_key) DO NOTHING`,
    [org, randomUUID(), testRoot, channel, source.mediaId, source.name, source.kind, source.id, requestHash]);
    const alias = (await tx.query<{ id: string; revision: number; requestHash: string }>(`SELECT id,revision,request_hash AS "requestHash"
      FROM automation_media_assets WHERE organization_id=$1 AND root_automation_id=$2 AND channel_id=$3 AND idempotency_key=$4 FOR SHARE`,
    [org, testRoot, channel, source.id])).rows[0];
    if (!alias || alias.requestHash !== requestHash) return setupFail('TEST_MEDIA_CHANGED');
    node.data.mediaId = alias.id; node.data.mediaRevision = alias.revision;
  }
  return copy;
}
