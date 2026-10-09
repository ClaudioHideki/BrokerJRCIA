import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import type { ProviderContext, EvolutionGroupCatalogItem } from '@jrc/providers';
import { WhatsAppGroupCatalogItemSchema, WhatsAppGroupCatalogPageQuerySchema, WhatsAppGroupCatalogPageSchema,
  UpdateWhatsAppGroupSelectionSchema, type WhatsAppGroupCatalogPage, type WhatsAppGroupCatalogPageQuery,
  type UpdateWhatsAppGroupSelection } from '@jrc/contracts';
import { requireActiveOrganization, TenantOperationalError } from '../tenancy/operational-limits.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { reconcileWhatsAppGroupParticipation } from './events.js';

export interface GroupCatalogPrincipal { organizationId: string; actorId: string }
export interface GroupCatalogOptions {
  encryptionKey: string;
  transact<T>(org: string, work: OrganizationTransaction<T>): Promise<T>;
  readIdentity(context: ProviderContext, instanceKey: string): Promise<{ connected: boolean; phone: string | null }>;
  readGroups(context: ProviderContext, instanceKey: string): Promise<EvolutionGroupCatalogItem[]>;
  ensureEventsConfiguration?(principal:GroupCatalogPrincipal,channel:string):Promise<void>;
}
export class GroupCatalogError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
interface CatalogRow {
  identity_revision: string; identity_fingerprint: string | null; catalog_revision: string;
  snapshot_id: string | null; observed_at: Date | null; valid_until: Date | null;
  last_attempt_at: Date; last_error_code: string | null; lease_token: string | null;
}
interface ChannelRow { instance_id: string; upstream_instance_key: string; connected: boolean }
const errors = new Set(['PROVIDER_ABORTED', 'PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_FAILED', 'PROVIDER_INVALID_RESPONSE']);
function providerCode(error: unknown) {
  const value = error as { code?: unknown; canonicalErrorCode?: unknown } | null;
  const code = value?.code ?? value?.canonicalErrorCode;
  return typeof code === 'string' && errors.has(code) ? code : 'PROVIDER_REQUEST_FAILED';
}
export function createWhatsAppGroupCatalog(options: GroupCatalogOptions) {
  const key = Buffer.from(options.encryptionKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== options.encryptionKey) throw new Error('INVALID_INTEGRATION_ENCRYPTION_KEY');
  async function access(tx: TenantTransaction, principal: GroupCatalogPrincipal, channel: string, write = false): Promise<ChannelRow> {
    z.uuid().parse(channel); z.uuid().parse(principal.organizationId); z.uuid().parse(principal.actorId);
    await requireActiveOrganization(tx, principal.organizationId);
    // This projection locks current membership AND active user; JWT roles alone
    // cannot authorize a result after provider I/O or a page kept open in a tab.
    const member = (await tx.query<{ role: string }>('SELECT role FROM lock_local_attendance_member($1)', [principal.actorId])).rows[0];
    if (!member || write && !['OWNER', 'ADMIN'].includes(member.role)) throw new GroupCatalogError('GROUP_ACCESS_DENIED', 403);
    try { await lockAttendanceChannel(tx, principal.organizationId, channel); }
    catch (error) {
      if ((error as { code?: unknown })?.code === 'CHANNEL_NOT_FOUND') throw new GroupCatalogError('GROUP_CHANNEL_NOT_FOUND', 404);
      throw error;
    }
    // Read AFTER acquiring locks: archive, deletion or disconnect may have
    // committed while this request waited for the instance/channel lock.
    const row = (await tx.query<ChannelRow>(`SELECT c.instance_id,i.upstream_instance_key,i.status='CONNECTED' AS connected
      FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
      WHERE c.organization_id=$1 AND c.id=$2 AND c.provider='BAILEYS' AND c.deleting_at IS NULL AND i.archived_at IS NULL`, [principal.organizationId, channel])).rows[0];
    if (!row) throw new GroupCatalogError('GROUP_CHANNEL_NOT_FOUND', 404);
    return row;
  }
  const catalog = async (tx: TenantTransaction, org: string, channel: string) =>
    (await tx.query<CatalogRow>('SELECT * FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE', [org, channel])).rows[0];
  async function pageIn(tx: TenantTransaction, principal: GroupCatalogPrincipal, channel: string, input: WhatsAppGroupCatalogPageQuery, connected: boolean): Promise<WhatsAppGroupCatalogPage> {
    const query = WhatsAppGroupCatalogPageQuerySchema.parse(input), row = await catalog(tx, principal.organizationId, channel);
    if (!row?.snapshot_id || !row.identity_fingerprint || !row.observed_at || !row.valid_until) throw new GroupCatalogError('GROUP_CATALOG_NOT_READY', 404);
    if (query.cursor && query.cursor.snapshotId !== row.snapshot_id) throw new GroupCatalogError('GROUP_CATALOG_CHANGED');
    const data = (await tx.query<Record<string, unknown>>(`SELECT group_jid AS "groupJid",subject,participant_count AS "participantCount",
      restrict,announce,is_community AS "isCommunity",is_community_announce AS "isCommunityAnnounce",linked_parent AS "linkedParent",
      selected,automation_enabled AS "automationEnabled" FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND channel_id=$2
      AND ($3::text IS NULL OR group_jid>$3) ORDER BY group_jid LIMIT $4`, [principal.organizationId, channel, query.cursor?.afterGroupJid ?? null, query.limit + 1])).rows;
    const total = Number((await tx.query<{ count: string }>('SELECT count(*)::text AS count FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND channel_id=$2', [principal.organizationId, channel])).rows[0]!.count);
    const items = data.slice(0, query.limit).map(item => WhatsAppGroupCatalogItemSchema.parse(item));
    const fresh = connected && !row.lease_token && !row.last_error_code && row.valid_until.getTime() > Date.now();
    return WhatsAppGroupCatalogPageSchema.parse({ snapshot: {
      schemaVersion: 1, scope: { provider: 'QR', organizationId: principal.organizationId, channelId: channel,
        identityRevision: Number(row.identity_revision), identityFingerprint: row.identity_fingerprint },
      snapshotId: row.snapshot_id, catalogRevision: Number(row.catalog_revision), observedAt: row.observed_at.toISOString(),
      status: fresh ? 'CURRENT' : 'STALE', lastAttemptAt: row.last_attempt_at.toISOString(), lastErrorCode: row.last_error_code,
    }, items, total, nextCursor: data.length > query.limit ? { snapshotId: row.snapshot_id, afterGroupJid: items.at(-1)!.groupJid } : null });
  }
  async function fail(org: string, channel: string, lease: string, code: string) {
    // Cleanup may release a read-only lease after membership revocation or a
    // lifecycle fence; it never inserts metadata or creates an external effect.
    await options.transact(org, tx => tx.query(`UPDATE whatsapp_group_catalogs SET lease_token=NULL,lease_expires_at=NULL,
      last_error_code=$4,updated_at=now() WHERE organization_id=$1 AND channel_id=$2 AND lease_token=$3`, [org, channel, lease, code]));
  }
  return {
    async refresh(principal: GroupCatalogPrincipal, channel: string): Promise<WhatsAppGroupCatalogPage> {
      // Existing explicit OWNER/ADMIN action also upgrades boxes connected
      // before G2. Configuration confirmation is independent of catalog facts.
      await options.ensureEventsConfiguration?.(principal,channel);
      const lease = randomUUID(), org = principal.organizationId;
      const captured = await options.transact(org, async tx => {
        const current = await access(tx, principal, channel, true);
        if (!current.connected) throw new GroupCatalogError('GROUP_CHANNEL_DISCONNECTED');
        await tx.query('INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [org, channel]);
        const claimed = await tx.query(`UPDATE whatsapp_group_catalogs SET lease_token=$3,lease_expires_at=clock_timestamp()+interval '60 seconds',
          last_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE organization_id=$1 AND channel_id=$2
          AND (lease_token IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING channel_id`, [org, channel, lease]);
        if (!claimed.rowCount) throw new GroupCatalogError('GROUP_CATALOG_REFRESHING');
        return current;
      });
      try {
        // All provider I/O owns a deadline outside every database transaction.
        // Before/after observations bind the catalog to an actually observed
        // number even for standalone channels with no Chatwoot health record.
        const context: ProviderContext = { organizationId: org, requestId: lease, deadline: new Date(Date.now() + 45000), signal: AbortSignal.timeout(45000) };
        const before = await options.readIdentity(context, captured.upstream_instance_key);
        if (!before.connected || !before.phone || !/^[1-9]\d{6,14}$/.test(before.phone)) throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
        const raw = await options.readGroups(context, captured.upstream_instance_key);
        const parsed = z.array(WhatsAppGroupCatalogItemSchema).max(2000).safeParse(raw);
        if (!parsed.success || new Set(raw.map(item => item.groupJid)).size !== raw.length) throw new GroupCatalogError('PROVIDER_INVALID_RESPONSE');
        const after = await options.readIdentity(context, captured.upstream_instance_key);
        if (!after.connected || after.phone !== before.phone) throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
        const fingerprint = createHmac('sha256', key).update(`whatsapp-group-identity:v1:${org}:${channel}:${before.phone}`).digest('hex');
        return await options.transact(org, async tx => {
          const current = await access(tx, principal, channel, true), previous = await catalog(tx, org, channel);
          if (!current.connected || current.instance_id !== captured.instance_id || current.upstream_instance_key !== captured.upstream_instance_key) throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
          const completed = await tx.query(`UPDATE whatsapp_group_catalogs SET snapshot_id=$4,observed_at=clock_timestamp(),valid_until=clock_timestamp()+interval '5 minutes',
            identity_revision=identity_revision+CASE WHEN identity_fingerprint IS NOT NULL AND identity_fingerprint<>$5 THEN 1 ELSE 0 END,
            identity_fingerprint=$5,catalog_revision=catalog_revision+1,last_error_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE organization_id=$1 AND channel_id=$2 AND lease_token=$3 AND lease_expires_at>clock_timestamp() RETURNING channel_id`, [org, channel, lease, randomUUID(), fingerprint]);
          if (!completed.rowCount) throw new GroupCatalogError('GROUP_REFRESH_LEASE_LOST');
          const selected = previous?.identity_fingerprint === fingerprint ? new Set((await tx.query<{ group_jid: string }>('SELECT group_jid FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND channel_id=$2 AND selected', [org, channel])).rows.map(item => item.group_jid)) : new Set<string>();
          await tx.query('DELETE FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND channel_id=$2', [org, channel]);
          if (parsed.data.length) await tx.query(`INSERT INTO whatsapp_group_catalog_items(organization_id,channel_id,group_jid,subject,participant_count,
            restrict,announce,is_community,is_community_announce,linked_parent,selected)
            SELECT $1,$2,x."groupJid",x.subject,x."participantCount",x.restrict,x.announce,x."isCommunity",x."isCommunityAnnounce",x."linkedParent",x.selected
            FROM jsonb_to_recordset($3::jsonb) AS x("groupJid" text,subject text,"participantCount" integer,restrict boolean,announce boolean,"isCommunity" boolean,"isCommunityAnnounce" boolean,"linkedParent" text,selected boolean)`,
            [org, channel, JSON.stringify(parsed.data.map(item => ({ ...item, selected: selected.has(item.groupJid) })))]);
          await reconcileWhatsAppGroupParticipation(tx, org, channel);
          return pageIn(tx, principal, channel, { limit: 50 }, true);
        });
      } catch (error) {
        const code = error instanceof GroupCatalogError ? error.code
          : error instanceof TenantOperationalError ? 'GROUP_ACCESS_DENIED' : providerCode(error);
        const recorded = code === 'GROUP_IDENTITY_CHANGED' ? 'IDENTITY_CHANGED' : code.startsWith('GROUP_') ? 'LEASE_LOST' : code;
        await fail(org, channel, lease, recorded);
        throw error instanceof GroupCatalogError || error instanceof TenantOperationalError
          ? error : new GroupCatalogError(code, 502);
      }
    },
    page: (principal: GroupCatalogPrincipal, channel: string, query: WhatsAppGroupCatalogPageQuery) => options.transact(principal.organizationId, async tx => {
      const current = await access(tx, principal, channel);
      return pageIn(tx, principal, channel, query, current.connected);
    }),
    async select(principal: GroupCatalogPrincipal, channel: string, input: UpdateWhatsAppGroupSelection): Promise<WhatsAppGroupCatalogPage> {
      const parsed = UpdateWhatsAppGroupSelectionSchema.parse(input);
      const check = (row: CatalogRow | undefined, connected: boolean) => {
      if (!row?.snapshot_id) throw new GroupCatalogError('GROUP_CATALOG_NOT_READY', 404);
      if (!connected || row.lease_token || row.last_error_code || !row.valid_until || row.valid_until.getTime() <= Date.now()) throw new GroupCatalogError('GROUP_CATALOG_STALE');
      if (row.snapshot_id !== parsed.expectedSnapshotId || Number(row.catalog_revision) !== parsed.expectedCatalogRevision) throw new GroupCatalogError('GROUP_CATALOG_CHANGED');
      if (row.identity_fingerprint !== parsed.expectedIdentityFingerprint || Number(row.identity_revision) !== parsed.expectedIdentityRevision) throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
      return row;
      };
      const captured = await options.transact(principal.organizationId, async tx => {
        const current = await access(tx, principal, channel, true);
        check(await catalog(tx, principal.organizationId, channel), current.connected);
        return current;
      });
      try {
        const context: ProviderContext = { organizationId: principal.organizationId, requestId: randomUUID(), deadline: new Date(Date.now() + 10000), signal: AbortSignal.timeout(10000) };
        const identity = await options.readIdentity(context, captured.upstream_instance_key);
        const fingerprint = identity.connected && identity.phone && /^[1-9]\d{6,14}$/.test(identity.phone)
          ? createHmac('sha256', key).update(`whatsapp-group-identity:v1:${principal.organizationId}:${channel}:${identity.phone}`).digest('hex') : null;
        if (fingerprint !== parsed.expectedIdentityFingerprint) throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
      } catch (error) {
        const code = error instanceof GroupCatalogError ? error.code : providerCode(error);
        await options.transact(principal.organizationId, tx => tx.query(`UPDATE whatsapp_group_catalogs SET last_error_code=$5,updated_at=clock_timestamp()
          WHERE organization_id=$1 AND channel_id=$2 AND snapshot_id=$3 AND catalog_revision=$4`, [principal.organizationId, channel, parsed.expectedSnapshotId, parsed.expectedCatalogRevision, code === 'GROUP_IDENTITY_CHANGED' ? 'IDENTITY_CHANGED' : code]));
        throw error instanceof GroupCatalogError ? error : new GroupCatalogError(code, 502);
      }
      return options.transact(principal.organizationId, async tx => {
      const current = await access(tx, principal, channel, true);
      const row = check(await catalog(tx, principal.organizationId, channel), current.connected);
      if (current.instance_id !== captured.instance_id || current.upstream_instance_key !== captured.upstream_instance_key) throw new GroupCatalogError('GROUP_IDENTITY_CHANGED');
      const updated = await tx.query('UPDATE whatsapp_group_catalog_items SET selected=$4 WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3', [principal.organizationId, channel, parsed.groupJid, parsed.enabled]);
      if (!updated.rowCount) throw new GroupCatalogError('GROUP_NOT_IN_CATALOG', 404);
      await tx.query('UPDATE whatsapp_group_catalogs SET catalog_revision=catalog_revision+1,updated_at=now() WHERE organization_id=$1 AND channel_id=$2', [principal.organizationId, channel]);
      await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
        VALUES($1,$2,'WHATSAPP_GROUP_SELECTION_CHANGED','messaging_channel',$3,$4,'SUCCESS',$5::jsonb)`, [principal.organizationId, principal.actorId, channel, randomUUID(), JSON.stringify({ snapshotId: row.snapshot_id, selected: parsed.enabled })]);
      return pageIn(tx, principal, channel, { limit: 50 }, true);
      });
    },
  };
}
