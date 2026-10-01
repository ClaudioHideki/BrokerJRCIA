import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AUTOMATION_ORIGIN, type AutomationBindingV1, type BindChannelAutomationV1,
  type BindChannelDestinationV1, type ChannelV1, type CreateChannelV1, type Instance,
  type PatchChannelV1 } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { InstanceActorContext, InstanceService } from '../instances/service.js';
import type { createMetaOnboardingService } from '../meta-onboarding/service.js';
import type { ChatwootService } from '../integrations/chatwoot-service.js';
import {lockOwnershipMutations,readOwnerRevision,transitionChannelOwner} from '../attendance/transition.js';
import { readAutomationAccess } from '../automations/availability.js';

export class ChannelFacadeError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503) { super(code); }
}

const channelCursorSchema = z.strictObject({ updatedAt: z.iso.datetime(), id: z.uuid() });
type ChannelCursor = z.infer<typeof channelCursorSchema>;
const readChannelCursor = (value: string): ChannelCursor => {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new ChannelFacadeError('CHANNEL_CURSOR_INVALID', 400);
  try { return channelCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))); }
  catch { throw new ChannelFacadeError('CHANNEL_CURSOR_INVALID', 400); }
};
const writeChannelCursor = (row: ChannelRow) => Buffer.from(JSON.stringify({ updatedAt: iso(row.updated_at), id: row.id })).toString('base64url');

interface ChannelRow {
  owner_revision?:number;
  id: string; organization_id: string; provider: 'BAILEYS' | 'META'; provider_account_id: string;
  instance_id: string | null; connection_id: string | null; name: string | null;
  instance_status: string | null; meta_status: 'PENDING' | 'READY' | 'REVOKED' | null;
  bot_public_id: string | null; bot_origin_reference: string | null; flow_published_version: number | null;
  flow_enabled: boolean | null; human_status: string | null; created_at: Date | string; updated_at: Date | string;
  archived_at?:Date|string|null;
  messaging_channel_id?:string|null; automation_binding_status?:string|null; automation_name?:string|null;
  integration_id?:string|null; inbox_id?:number|string|null; inbox_name?:string|null; observed_last4?:string|null;
}

interface AutomationBindingRow {
  id: string; organizationId: string; automationId: string; version: number; channelId: string;
  humanDestinationId: string | null; status: 'ACTIVE' | 'PAUSED' | 'DISABLED'; revision: number;
  createdAt: Date | string; updatedAt: Date | string;
}

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const qrTransport = (status: string | null): ChannelV1['transportStatus'] => {
  if (status === 'CONNECTED') return 'CONNECTED';
  if (status === 'CONNECTING' || status === 'AWAITING_ACTION') return 'PAIRING';
  if (status === 'DISCONNECTING' || status === 'DISCONNECTED') return 'DISCONNECTED';
  if (status === 'ERROR' || status === 'PROVISIONING_FAILED') return 'DEGRADED';
  if (status === 'PROVISIONING' || status === 'CREATED') return 'CREATED';
  return 'UNKNOWN';
};
const automationStatus = (row: ChannelRow): ChannelV1['automationStatus'] => {
  if (!row.bot_public_id) return 'UNBOUND';
  if (row.bot_origin_reference === AUTOMATION_ORIGIN) return row.automation_binding_status === 'ACTIVE' ? 'ACTIVE'
    : row.automation_binding_status === 'PAUSED' ? 'PAUSED' : 'UNBOUND';
  if (row.bot_origin_reference !== 'jrc-flows-native') return 'ACTIVE';
  if (!row.flow_published_version) return 'DRAFT';
  return row.flow_enabled === false ? 'PAUSED' : 'ACTIVE';
};
const humanStatus = (status: string | null): ChannelV1['humanStatus'] => {
  if (!status) return 'UNBOUND';
  if (status === 'READY') return 'READY';
  if (status === 'DISABLED') return 'DISABLED';
  if (status === 'FAILED') return 'DEGRADED';
  return 'UNKNOWN';
};

export function channelView(row: ChannelRow): ChannelV1 {
  const common = {
    schemaVersion: 1 as const,
    id: row.id,
    organizationId: row.organization_id,
    identity: { displayName: row.name, maskedAddress: row.observed_last4 ? `****${row.observed_last4}` : null },
    archivedAt:row.archived_at?iso(row.archived_at):null,
    messagingChannelId:row.messaging_channel_id??null,
    automationName:row.automation_name??null,
    destination:row.integration_id?{integrationId:row.integration_id,inboxId:row.inbox_id?Number(row.inbox_id):null,name:row.inbox_name??'Caixa de atendimento'}:null,
    automationStatus: automationStatus(row),
    humanStatus: humanStatus(row.human_status),
    revision: 1,
    ownerRevision:row.owner_revision??0,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.provider === 'BAILEYS') return {
    ...common,
    provider: 'QR',
    providerReference: { providerAccountId: row.provider_account_id, instanceId: row.instance_id! },
    transportStatus: qrTransport(row.instance_status),
    providerStatus: row.instance_status === 'ERROR' || row.instance_status === 'PROVISIONING_FAILED' ? 'DEGRADED'
      : row.instance_status === 'PROVISIONING' ? 'PENDING' : 'READY',
  };
  return {
    ...common,
    provider: 'META',
    providerReference: { providerAccountId: row.provider_account_id, connectionId: row.connection_id! },
    transportStatus: row.meta_status === 'READY' ? 'CONNECTED' : row.meta_status === 'REVOKED' ? 'DISCONNECTED' : 'CREATED',
    providerStatus: row.meta_status === 'READY' ? 'READY' : row.meta_status === 'REVOKED' ? 'REVOKED' : 'PENDING',
  };
}

function fromInstance(instance: Instance): ChannelV1 {
  return channelView({ id: instance.id, organization_id: instance.organizationId, provider: 'BAILEYS',
    provider_account_id: instance.providerAccountId, instance_id: instance.id, connection_id: null, name: instance.name,
    instance_status: instance.status, meta_status: null, bot_public_id: null, bot_origin_reference: null,
    flow_published_version: null, flow_enabled: null, human_status: null,
    created_at: instance.createdAt, updated_at: instance.updatedAt });
}

function bindingView(row: AutomationBindingRow): AutomationBindingV1 {
  return { ...row, schemaVersion: 1, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

export interface ChannelFacadeOptions {
  automationStatus?(org:string):Promise<{canPublish:boolean;reasons:string[]}>;
  instances: InstanceService;
  meta: Pick<ReturnType<typeof createMetaOnboardingService>, 'start'>;
  activateQr?(org:string,instanceId:string):Promise<{id:string}>;
  chatwoot?: Pick<ChatwootService, 'connect'> | undefined;
  transact<T>(organizationId: string, operation: OrganizationTransaction<T>): Promise<T>;
}

export function createChannelFacade(options: ChannelFacadeOptions) {
  async function rows(org: string, id?: string, page?: { pageSize: number; cursor?: ChannelCursor; includeArchived: boolean }): Promise<ChannelRow[]> {
    const params: unknown[] = [org];
    if (id) params.push(id);
    const union = `
      SELECT i.id,i.organization_id,'BAILEYS'::text AS provider,i.provider_account_id,i.id AS instance_id,
        NULL::uuid AS connection_id,i.name,i.status::text AS instance_status,NULL::text AS meta_status,
        c.bot_public_id,c.bot_origin_reference,f.published_version AS flow_published_version,ff.enabled AS flow_enabled,
        cw.status AS human_status,i.created_at,GREATEST(i.updated_at,COALESCE(c.updated_at,i.updated_at),COALESCE(cw.updated_at,i.updated_at)) AS updated_at,
        c.id AS messaging_channel_id,ab.status AS automation_binding_status,ad.name AS automation_name,
        coalesce((select revision from attendance_owners ao where ao.organization_id=c.organization_id and ao.channel_id=c.id),0) AS owner_revision,
        cw.id AS integration_id,cw.inbox_id,cw.name AS inbox_name,h.observed_last4,i.archived_at
      FROM instances i
      JOIN provider_accounts pa ON pa.organization_id=i.organization_id AND pa.id=i.provider_account_id AND pa.provider='BAILEYS'
      LEFT JOIN messaging_channels c ON c.organization_id=i.organization_id AND c.instance_id=i.id
      LEFT JOIN flows f ON f.organization_id=c.organization_id AND f.id::text=c.bot_public_id AND c.bot_origin_reference='jrc-flows-native'
      LEFT JOIN flow_features ff ON ff.organization_id=i.organization_id
      LEFT JOIN chatwoot_connections cw ON cw.organization_id=c.organization_id AND cw.channel_id=c.id
      LEFT JOIN chatwoot_connection_health h ON h.organization_id=c.organization_id AND h.channel_id=c.id
      LEFT JOIN automation_bindings ab ON ab.organization_id=c.organization_id AND ab.channel_id=c.id AND ab.status IN ('ACTIVE','PAUSED') AND ab.automation_id::text=c.bot_public_id
      LEFT JOIN automation_definitions ad ON ad.organization_id=ab.organization_id AND ad.id=ab.automation_id
      WHERE i.organization_id=$1 ${id ? 'AND i.id=$2' : ''}
      UNION ALL
      SELECT m.id,m.organization_id,'META'::text,c.provider_account_id,NULL::uuid,m.id,'WhatsApp oficial',NULL::text,m.status,
        c.bot_public_id,c.bot_origin_reference,f.published_version,ff.enabled,cw.status,c.created_at,GREATEST(m.updated_at,c.updated_at,COALESCE(cw.updated_at,m.updated_at)),
        c.id,ab.status,ad.name,coalesce((select revision from attendance_owners ao where ao.organization_id=c.organization_id and ao.channel_id=c.id),0),cw.id,cw.inbox_id,cw.name,NULL::text,NULL::timestamptz
      FROM meta_connections m
      JOIN messaging_channels c ON c.organization_id=m.organization_id AND c.id=m.channel_id AND c.provider='META'
      LEFT JOIN flows f ON f.organization_id=c.organization_id AND f.id::text=c.bot_public_id AND c.bot_origin_reference='jrc-flows-native'
      LEFT JOIN flow_features ff ON ff.organization_id=m.organization_id
      LEFT JOIN chatwoot_connections cw ON cw.organization_id=c.organization_id AND cw.channel_id=c.id
      LEFT JOIN automation_bindings ab ON ab.organization_id=c.organization_id AND ab.channel_id=c.id AND ab.status IN ('ACTIVE','PAUSED') AND ab.automation_id::text=c.bot_public_id
      LEFT JOIN automation_definitions ad ON ad.organization_id=ab.organization_id AND ad.id=ab.automation_id
      WHERE m.organization_id=$1 ${id ? 'AND m.id=$2' : ''}`;
    if (!page) return options.transact(org, async tx => (await tx.query<ChannelRow>(`${union} ORDER BY updated_at DESC,id`, params)).rows);
    const conditions = page.includeArchived ? [] : ['channel_rows.archived_at IS NULL'];
    if (page.cursor) {
      const timeIndex = params.push(page.cursor.updatedAt);
      const idIndex = params.push(page.cursor.id);
      const time = `date_trunc('milliseconds', channel_rows.updated_at)`;
      conditions.push(`(${time} < $${timeIndex}::timestamptz OR (${time} = $${timeIndex}::timestamptz AND channel_rows.id > $${idIndex}::uuid))`);
    }
    const limitIndex = params.push(page.pageSize + 1);
    const sql = `SELECT * FROM (${union}) AS channel_rows ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY date_trunc('milliseconds', channel_rows.updated_at) DESC,channel_rows.id LIMIT $${limitIndex}`;
    return options.transact(org, async tx => (await tx.query<ChannelRow>(sql, params)).rows);
  }
  async function get(org: string, id: string) {
    const found = (await rows(org, id))[0];
    if (!found) throw new ChannelFacadeError('CHANNEL_NOT_FOUND', 404);
    return channelView(found);
  }
  async function messagingChannelId(org: string, channel: ChannelV1,activate=false): Promise<string> {
    if(activate&&channel.provider==='QR'&&options.activateQr)return (await options.activateQr(org,channel.providerReference.instanceId)).id;
    return options.transact(org, async tx => {
      const query = channel.provider === 'QR'
        ? ['SELECT id FROM messaging_channels WHERE organization_id=$1 AND instance_id=$2', channel.providerReference.instanceId] as const
        : ['SELECT channel_id AS id FROM meta_connections WHERE organization_id=$1 AND id=$2', channel.providerReference.connectionId] as const;
      const found = (await tx.query<{ id: string }>(query[0], [org, query[1]])).rows[0]?.id;
      if (!found) throw new ChannelFacadeError('CHANNEL_NOT_FOUND', 404);
      return found;
    });
  }
  const mutation = (result: Awaited<ReturnType<InstanceService['disconnectInstance']>>) => ({
    provider: 'QR' as const, channel: fromInstance(result.instance), operationId: result.operationId,
    replayed: result.replayed, pending: result.pending, reconciliationRequired: result.reconciliationRequired,
  });
  return {
    async list(org: string,includeArchived=false,page:{pageSize:number;cursor?:string}={pageSize:50}) {
      if (!Number.isInteger(page.pageSize) || page.pageSize < 1 || page.pageSize > 100) throw new ChannelFacadeError('CHANNEL_PAGE_SIZE_INVALID',400);
      const cursor = page.cursor ? readChannelCursor(page.cursor) : undefined;
      const found = await rows(org, undefined, { pageSize: page.pageSize, includeArchived, ...(cursor ? { cursor } : {}) });
      const data = found.slice(0,page.pageSize);
      return { data: data.map(channelView), nextCursor: found.length > page.pageSize ? writeChannelCursor(data.at(-1)!) : null };
    },
    get,
    async setArchived(org:string,id:string,archived:boolean,actorId?:string,platformActorId?:string){
      await options.transact(org,async tx=>{
        await lockOwnershipMutations(tx,org);
        const row=(await tx.query<{status:string;archived_at:Date|null}>('select status,archived_at from instances where organization_id=$1 and id=$2 for update',[org,id])).rows[0];
        if(!row)throw new ChannelFacadeError('CHANNEL_NOT_FOUND',404);
        if(Boolean(row.archived_at)===archived)return;
        if(archived){
          if(!['DISCONNECTED','PROVISIONING_FAILED'].includes(row.status))throw new ChannelFacadeError('CHANNEL_DISCONNECT_REQUIRED',409);
          const operations=await tx.query("select 1 from provider_operations where organization_id=$1 and instance_id=$2 and (status in ('PENDING','UNKNOWN') or reconciliation_required) limit 1",[org,id]);
          if(operations.rowCount)throw new ChannelFacadeError('CHANNEL_HAS_PENDING_WORK',409);
          const channels=await tx.query<{id:string}>('select id from messaging_channels where organization_id=$1 and instance_id=$2 order by id for no key update',[org,id]);
          for(const channel of channels.rows){
            const bindings=await tx.query("select 1 from automation_bindings where organization_id=$1 and channel_id=$2 and status in ('ACTIVE','PAUSED')",[org,channel.id]);
            const destination=await tx.query("select 1 from chatwoot_connections where organization_id=$1 and channel_id=$2 and status<>'DISABLED'",[org,channel.id]);
            const work=await tx.query(`select 1 where exists(select 1 from messaging_messages where organization_id=$1 and channel_id=$2 and direction='OUTGOING' and state in ('ACCEPTED','SENDING','UNKNOWN'))
             or exists(select 1 from automation_executions e where e.organization_id=$1 and e.channel_id=$2 and (e.status in ('QUEUED','RUNNING','WAITING','UNKNOWN') or exists(select 1 from automation_outbox o where o.organization_id=e.organization_id and o.execution_id=e.id and o.status in ('PENDING','SENDING','UNKNOWN'))))`,[org,channel.id]);
            if(bindings.rowCount||destination.rowCount)throw new ChannelFacadeError('CHANNEL_UNLINK_REQUIRED',409);
            if(work.rowCount)throw new ChannelFacadeError('CHANNEL_HAS_PENDING_WORK',409);
            await transitionChannelOwner(tx,org,{channelId:channel.id,botPublicId:null,botOriginReference:null});
          }
        }
        await tx.query('update instances set archived_at=case when $3 then now() else null end,updated_at=now() where organization_id=$1 and id=$2',[org,id,archived]);
        await tx.query(`insert into audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata) values($1,$2,$3,'instance',$4,$5,'SUCCESS',$6)`,[org,actorId??null,archived?'CHANNEL_ARCHIVED':'CHANNEL_RESTORED',id,randomUUID(),JSON.stringify(platformActorId?{platformActorId}:{})]);
      });return get(org,id);
    },
    async patch(org: string, id: string, input: PatchChannelV1) {
      const channel = await get(org, id);
      if (channel.provider !== 'QR') throw new ChannelFacadeError('CHANNEL_PATCH_UNSUPPORTED', 409);
      const updated = await options.transact(org, async tx => (await tx.query<{ id: string }>(
        'UPDATE instances SET name=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id',
        [org, channel.providerReference.instanceId, input.displayName])).rows[0]);
      if (!updated) throw new ChannelFacadeError('CHANNEL_NOT_FOUND', 404);
      return get(org, id);
    },
    async status(context: InstanceActorContext, id: string) {
      const channel = await get(context.organizationId, id);
      if (channel.provider === 'QR') await options.instances.getInstanceStatus(context, channel.providerReference.instanceId);
      return get(context.organizationId, id);
    },
    async create(context: InstanceActorContext, actorId: string, input: CreateChannelV1, idempotencyKey: string) {
      if (input.provider === 'META') {
        const action = await options.meta.start(context.organizationId, actorId);
        return { provider: 'META' as const, action: { type: 'EMBEDDED_SIGNUP' as const, ...action } };
      }
      const result = await options.instances.createInstance(context, { name: input.name, provider: 'BAILEYS',
        providerAccountId: input.providerAccountId, idempotencyKey });
      return { provider: 'QR' as const, channel: fromInstance(result.instance), operationId: result.operationId,
        replayed: result.replayed, pending: result.pending, reconciliationRequired: result.reconciliationRequired };
    },
    async pair(context: InstanceActorContext, id: string, idempotencyKey: string) {
      const channel = await get(context.organizationId, id);
      if (channel.provider !== 'QR') throw new ChannelFacadeError('CHANNEL_PAIR_UNSUPPORTED', 409);
      const result = await options.instances.connectInstance(context, { instanceId: channel.providerReference.instanceId, idempotencyKey });
      return { provider: 'QR' as const, channel: fromInstance(result.instance), operationId: result.operationId,
        replayed: result.replayed, pending: result.pending, reconciliationRequired: result.reconciliationRequired, action: result.action };
    },
    async reconnect(context: InstanceActorContext, id: string, idempotencyKey: string) {
      const channel = await get(context.organizationId, id);
      if (channel.provider !== 'QR') throw new ChannelFacadeError('CHANNEL_RECONNECT_UNSUPPORTED', 409);
      const result = await options.instances.connectInstance(context, { instanceId: channel.providerReference.instanceId, idempotencyKey });
      return { ...mutation(result), action: result.action };
    },
    async disconnect(context: InstanceActorContext, id: string, idempotencyKey: string) {
      const channel = await get(context.organizationId, id);
      if (channel.provider !== 'QR') throw new ChannelFacadeError('CHANNEL_DISCONNECT_UNSUPPORTED', 409);
      return mutation(await options.instances.disconnectInstance(context,
        { instanceId: channel.providerReference.instanceId, idempotencyKey }));
    },
    async getAutomation(org: string, id: string) {
      const channel = await get(org, id);
      if(!channel.messagingChannelId)return {binding:null,ownerRevision:0};
      const channelId=channel.messagingChannelId;
      return options.transact(org, async tx => {
        await tx.query('SELECT id FROM messaging_channels WHERE organization_id=$1 AND id=$2 FOR SHARE',[org,channelId]);
        const binding = (await tx.query<AutomationBindingRow>(`
        SELECT id,organization_id AS "organizationId",automation_id AS "automationId",version,
          channel_id AS "channelId",human_destination_id AS "humanDestinationId",status,revision,
          created_at AS "createdAt",updated_at AS "updatedAt"
        FROM automation_bindings
        WHERE organization_id=$1 AND channel_id=$2 AND status IN ('ACTIVE','PAUSED')
        ORDER BY updated_at DESC LIMIT 1`, [org, channelId])).rows[0];
        return { binding: binding ? bindingView(binding) : null,ownerRevision:await readOwnerRevision(tx,org,channelId) };
      });
    },
    async bindAutomation(org: string, id: string, input: Omit<BindChannelAutomationV1,'expectedOwnerRevision'>&{expectedOwnerRevision?:number}) {
      if(options.automationStatus){const availability=await options.automationStatus(org);if(!availability.canPublish){
        const code=availability.reasons[0]??'AUTOMATION_DEPENDENCY_UNAVAILABLE';
        throw new ChannelFacadeError(code,code==='AUTOMATION_DEPENDENCY_UNAVAILABLE'?503:code==='AUTOMATION_RUNTIME_DISABLED'?409:403);
      }}
      const channel = await get(org, id), channelId = await messagingChannelId(org, channel,true);
      return options.transact(org, async tx => {
        await lockOwnershipMutations(tx,org);
        const access=await readAutomationAccess(tx,org);
        if(access?.status!=='ACTIVE')throw new ChannelFacadeError('ORGANIZATION_NOT_ACTIVE',403);
        if(!access.moduleEnabled)throw new ChannelFacadeError('AUTOMATION_MODULE_DISABLED',403);
        const result=await transitionChannelOwner(tx,org,{...input,channelId,botPublicId:input.automationId,botOriginReference:AUTOMATION_ORIGIN});
        return {binding:bindingView(result.binding!),ownerRevision:result.ownerRevision};
      });
    },    async bindDestination(org: string, id: string, input: BindChannelDestinationV1, actorId?: string) {
      if (!options.chatwoot) throw new ChannelFacadeError('CHATWOOT_NOT_CONFIGURED', 503);
      const channel = await get(org, id);
      let source: { instanceId: string } | { channelId: string };
      if (channel.provider === 'QR') source = { instanceId: channel.providerReference.instanceId };
      else {
        const channelId = await options.transact(org, async tx => (await tx.query<{ channel_id: string }>(
          'SELECT channel_id FROM meta_connections WHERE organization_id=$1 AND id=$2', [org, channel.providerReference.connectionId])).rows[0]?.channel_id);
        if (!channelId) throw new ChannelFacadeError('CHANNEL_NOT_FOUND', 404);
        source = { channelId };
      }
      await options.chatwoot.connect(org, { ...source, name: input.name, ...(input.inboxId ? { inboxId: input.inboxId } : {}),
        replaceExistingWebhook: input.replaceExistingWebhook }, actorId);
      return get(org, id);
    },
  };
}
export type ChannelFacade = ReturnType<typeof createChannelFacade>;
