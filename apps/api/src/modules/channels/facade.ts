import { randomUUID } from 'node:crypto';
import { AUTOMATION_ORIGIN, type AutomationBindingV1, type BindChannelAutomationV1,
  type BindChannelDestinationV1, type ChannelV1, type CreateChannelV1, type Instance,
  type PatchChannelV1 } from '@jrc/contracts';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { InstanceActorContext, InstanceService } from '../instances/service.js';
import type { createMetaOnboardingService } from '../meta-onboarding/service.js';
import type { ChatwootService } from '../integrations/chatwoot-service.js';

export class ChannelFacadeError extends Error {
  constructor(readonly code: string, readonly status: 404 | 409 | 503) { super(code); }
}

interface ChannelRow {
  id: string; organization_id: string; provider: 'BAILEYS' | 'META'; provider_account_id: string;
  instance_id: string | null; connection_id: string | null; name: string | null;
  instance_status: string | null; meta_status: 'PENDING' | 'READY' | 'REVOKED' | null;
  bot_public_id: string | null; bot_origin_reference: string | null; flow_published_version: number | null;
  flow_enabled: boolean | null; human_status: string | null; created_at: Date | string; updated_at: Date | string;
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
    identity: { displayName: row.name, maskedAddress: null },
    automationStatus: automationStatus(row),
    humanStatus: humanStatus(row.human_status),
    revision: 1,
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
  instances: InstanceService;
  meta: Pick<ReturnType<typeof createMetaOnboardingService>, 'start'>;
  chatwoot?: Pick<ChatwootService, 'connect'> | undefined;
  transact<T>(organizationId: string, operation: OrganizationTransaction<T>): Promise<T>;
}

export function createChannelFacade(options: ChannelFacadeOptions) {
  async function rows(org: string): Promise<ChannelRow[]> {
    return options.transact(org, async tx => (await tx.query<ChannelRow>(`
      SELECT i.id,i.organization_id,'BAILEYS'::text AS provider,i.provider_account_id,i.id AS instance_id,
        NULL::uuid AS connection_id,i.name,i.status::text AS instance_status,NULL::text AS meta_status,
        c.bot_public_id,c.bot_origin_reference,f.published_version AS flow_published_version,ff.enabled AS flow_enabled,
        cw.status AS human_status,i.created_at,GREATEST(i.updated_at,COALESCE(c.updated_at,i.updated_at),COALESCE(cw.updated_at,i.updated_at)) AS updated_at
      FROM instances i
      JOIN provider_accounts pa ON pa.organization_id=i.organization_id AND pa.id=i.provider_account_id AND pa.provider='BAILEYS'
      LEFT JOIN messaging_channels c ON c.organization_id=i.organization_id AND c.instance_id=i.id
      LEFT JOIN flows f ON f.organization_id=c.organization_id AND f.id::text=c.bot_public_id AND c.bot_origin_reference='jrc-flows-native'
      LEFT JOIN flow_features ff ON ff.organization_id=i.organization_id
      LEFT JOIN chatwoot_connections cw ON cw.organization_id=c.organization_id AND cw.channel_id=c.id
      WHERE i.organization_id=$1
      UNION ALL
      SELECT m.id,m.organization_id,'META'::text,c.provider_account_id,NULL::uuid,m.id,'WhatsApp oficial',NULL::text,m.status,
        c.bot_public_id,c.bot_origin_reference,f.published_version,ff.enabled,cw.status,c.created_at,GREATEST(m.updated_at,c.updated_at,COALESCE(cw.updated_at,m.updated_at))
      FROM meta_connections m
      JOIN messaging_channels c ON c.organization_id=m.organization_id AND c.id=m.channel_id AND c.provider='META'
      LEFT JOIN flows f ON f.organization_id=c.organization_id AND f.id::text=c.bot_public_id AND c.bot_origin_reference='jrc-flows-native'
      LEFT JOIN flow_features ff ON ff.organization_id=m.organization_id
      LEFT JOIN chatwoot_connections cw ON cw.organization_id=c.organization_id AND cw.channel_id=c.id
      WHERE m.organization_id=$1
      ORDER BY updated_at DESC,id`, [org])).rows);
  }
  async function get(org: string, id: string) {
    const found = (await rows(org)).find(row => row.id === id);
    if (!found) throw new ChannelFacadeError('CHANNEL_NOT_FOUND', 404);
    return channelView(found);
  }
  async function messagingChannelId(org: string, channel: ChannelV1): Promise<string> {
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
    async list(org: string) { return { data: (await rows(org)).map(channelView) }; },
    get,
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
      const channel = await get(org, id), channelId = await messagingChannelId(org, channel);
      const binding = await options.transact(org, async tx => (await tx.query<AutomationBindingRow>(`
        SELECT id,organization_id AS "organizationId",automation_id AS "automationId",version,
          channel_id AS "channelId",human_destination_id AS "humanDestinationId",status,revision,
          created_at AS "createdAt",updated_at AS "updatedAt"
        FROM automation_bindings
        WHERE organization_id=$1 AND channel_id=$2 AND status IN ('ACTIVE','PAUSED')
        ORDER BY updated_at DESC LIMIT 1`, [org, channelId])).rows[0]);
      return { binding: binding ? bindingView(binding) : null };
    },
    async bindAutomation(org: string, id: string, input: BindChannelAutomationV1) {
      const channel = await get(org, id), channelId = await messagingChannelId(org, channel);
      return options.transact(org, async tx => {
        const definition = (await tx.query<{ activeVersion: number | null }>(
          'SELECT active_version AS "activeVersion" FROM automation_definitions WHERE organization_id=$1 AND id=$2',
          [org, input.automationId])).rows[0];
        if (!definition) throw new ChannelFacadeError('AUTOMATION_NOT_FOUND', 404);
        const version = input.version ?? definition.activeVersion;
        if (!version) throw new ChannelFacadeError('AUTOMATION_NOT_PUBLISHED', 409);
        const published = (await tx.query<{ version: number }>(
          'SELECT version FROM automation_versions WHERE organization_id=$1 AND automation_id=$2 AND version=$3',
          [org, input.automationId, version])).rows[0];
        if (!published) throw new ChannelFacadeError('AUTOMATION_VERSION_NOT_FOUND', 404);
        await tx.query(`UPDATE automation_bindings SET status='DISABLED',revision=revision+1,updated_at=now()
          WHERE organization_id=$1 AND channel_id=$2 AND status IN ('ACTIVE','PAUSED')`, [org, channelId]);
        const binding = (await tx.query<AutomationBindingRow>(`
          INSERT INTO automation_bindings(organization_id,id,automation_id,version,channel_id,human_destination_id)
          VALUES($1,$2,$3,$4,$5,$6)
          RETURNING id,organization_id AS "organizationId",automation_id AS "automationId",version,
            channel_id AS "channelId",human_destination_id AS "humanDestinationId",status,revision,
            created_at AS "createdAt",updated_at AS "updatedAt"`,
        [org, randomUUID(), input.automationId, version, channelId, input.humanDestinationId ?? null])).rows[0]!;
        await tx.query(`UPDATE messaging_channels SET bot_public_id=$3,bot_origin_reference=$4,updated_at=now()
          WHERE organization_id=$1 AND id=$2`, [org, channelId, input.automationId, AUTOMATION_ORIGIN]);
        return { binding: bindingView(binding) };
      });
    },
    async bindDestination(org: string, id: string, input: BindChannelDestinationV1, actorId?: string) {
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
