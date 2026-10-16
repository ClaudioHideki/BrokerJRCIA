import type {EvolutionFleetRuntime,EngineSnapshot} from '../evolution-fleet/runtime.js';
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { EvolutionMessagingClient } from "@jrc/providers";
import type {
  OrganizationTransaction,
  TenantTransaction,
} from "../../db/tenant-transaction.js";
import { createPostgresMessagingRepository } from "./repository.js";
import { normalizeQrEvent,normalizeQrHistoryEvent,qrPhone,type QrContactEvent } from "./qr-events.js";
import {canAdvanceMessageState,lockMessageStatusKey} from './message-state.js';
import {observeQrIdentityScope,resolveQrIdentityEvents,recoverQrIdentityEvents} from './qr-identity.js';
import type { MessagingChannel,MessageState,OutboxClaim } from "./types.js";
import { requireActiveOrganization } from "../tenancy/operational-limits.js";
import { registerPendingMedia } from "./media-store.js";
import type { MessageContent } from "./types.js";
import type { ChatwootHealth } from '../integrations/chatwoot-health.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import {SUPERSEDED_PHYSICAL_CYCLE_PREFIX} from '../attendance/conversation-cycle-fence.js';
import { recordQrOutboundObservation } from './qr-outbound-observation.js';
import type { createWhatsAppGroupEvents } from '../whatsapp-groups/events.js';
import type { createGroupAutomationRuntime } from '../whatsapp-groups/automation-runtime.js';

const error = (code: string, status = 422) =>
  Object.assign(new Error(code), { code, status });
export interface QrServiceOptions {
  fleet?: EvolutionFleetRuntime;
  baseUrl: string;
  apiKey: string;
  webhookOrigin: string;
  signingKey: string;
  identity?: ChatwootHealth | undefined;
  groups?: ReturnType<typeof createWhatsAppGroupEvents> | undefined;
  groupAutomation?: Pick<ReturnType<typeof createGroupAutomationRuntime>, 'ingestWithinTransaction'> | undefined;
  transact<T>(org: string, operation: OrganizationTransaction<T>): Promise<T>;
  resolveChannel(
    id: string,
  ): Promise<{ organizationId: string; instanceId: string } | undefined>;
}
export async function ensureQrChannel(
  tx: TenantTransaction,
  org: string,
  instanceId: string,
): Promise<MessagingChannel> {
  await requireActiveOrganization(tx, org);
  const instance = (
    await tx.query<{ id: string; provider_account_id: string }>(
      `SELECT i.id,i.provider_account_id FROM instances i JOIN provider_accounts p
       ON p.organization_id=i.organization_id AND p.id=i.provider_account_id
     WHERE i.organization_id=$1 AND i.id=$2 AND p.provider='BAILEYS' AND i.status NOT IN ('PROVISIONING','PROVISIONING_FAILED') FOR UPDATE OF i`,
      [org, instanceId],
    )
  ).rows[0];
  if (!instance) throw error("QR_INSTANCE_NOT_FOUND", 404);
  await tx.query(
    `INSERT INTO messaging_channels(organization_id,provider_account_id,provider,instance_id,credential_reference)
    VALUES($1,$2,'BAILEYS',$3,'qr-engine') ON CONFLICT(organization_id,instance_id) WHERE instance_id IS NOT NULL DO NOTHING`,
    [org, instance.provider_account_id, instance.id],
  );
  const result = await tx.query<{ id: string }>(
    "SELECT id FROM messaging_channels WHERE organization_id=$1 AND instance_id=$2",
    [org, instanceId],
  );
  return (await createPostgresMessagingRepository().findChannel(
    tx,
    org,
    result.rows[0]!.id,
  ))!;
}
export function createQrMessagingService(options: QrServiceOptions) {
  if (options.signingKey.length < 32) throw error("INVALID_QR_SIGNING_KEY");
  const repository = createPostgresMessagingRepository();
  const bindingFingerprint=(engine?:EngineSnapshot)=>createHmac('sha256',options.signingKey).update(JSON.stringify(engine
    ? ['qr-engine:v1',engine.engineId,engine.generation,engine.destinationFingerprint,engine.traditional]
    : ['qr-engine:v1',new URL(options.baseUrl).origin])).digest('hex');
  async function persistContactEvent(tx:TenantTransaction,channel:MessagingChannel,event:QrContactEvent){
    const org=channel.organizationId,channelId=channel.id;
    const observed=event.kind==='outbound'||event.kind==='outbound-media';
    if(observed)await lockAttendanceChannel(tx,org,channelId);
    else await repository.findChannel(tx,org,channelId,{lock:true});
    // An old pushName cannot replace the current contact identity/name.
    const contact=event.historical
      ? (await tx.query<{id:string}>(`INSERT INTO messaging_contacts(id,organization_id,external_id,display_name,consent_status)
          VALUES($1,$2,$3,$4,'UNKNOWN') ON CONFLICT(organization_id,external_id) DO NOTHING RETURNING id`,[randomUUID(),org,event.externalId,event.displayName])).rows[0]
        ?? (await tx.query<{id:string}>('SELECT id FROM messaging_contacts WHERE organization_id=$1 AND external_id=$2',[org,event.externalId])).rows[0]!
      : await repository.upsertContact(tx,{id:randomUUID(),organizationId:org,externalId:event.externalId,
          displayName:event.displayName,consentStatus:'UNKNOWN',consentUpdatedAt:null});
    const conversation=await repository.getOrCreateConversation(tx,{id:randomUUID(),organizationId:org,channelId,contactId:contact.id});
    if(event.historical){
      await lockMessageStatusKey(tx,org,channelId,event.upstreamMessageId);
      const existing=(await tx.query<{direction:string;conversation_id:string;contact_id:string|null;remote_conversation_key:string|null}>(`SELECT m.direction,m.conversation_id,c.contact_id,c.remote_conversation_key
        FROM messaging_messages m JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
        WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.provider_scope='' AND m.upstream_message_id=$3`,[org,channelId,event.upstreamMessageId])).rows[0];
      if(existing){
        const samePhysicalHistory=existing.contact_id===contact.id&&existing.remote_conversation_key?.startsWith(SUPERSEDED_PHYSICAL_CYCLE_PREFIX);
        if(existing.direction!==(observed?'OUTGOING':'INCOMING')||(existing.conversation_id!==conversation.id&&!samePhysicalHistory))throw error('QR_HISTORY_ID_CONFLICT',409);
        return;
      }
      if(observed){
        const uncertain=(await tx.query(`SELECT 1 FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('DISPATCHED','UNKNOWN','ABANDONED') LIMIT 1`,[org,conversation.id])).rowCount;
        if(uncertain)throw error('QR_HISTORY_ACK_PENDING',503);
        let state:MessageState='SENT';
        const statuses=(await tx.query<{state:MessageState}>(`SELECT state FROM messaging_status_events
          WHERE organization_id=$1 AND channel_id=$2 AND upstream_message_id=$3 AND provider_scope='' ORDER BY occurred_at,id`,[org,channelId,event.upstreamMessageId])).rows;
        for(const status of statuses)if(canAdvanceMessageState(state,status.state))state=status.state;
        await tx.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state,created_at,updated_at)
          VALUES($1,$2,$3,$4,'OUTGOING','EXTERNAL_OBSERVED',$5,$6,$8,$7,$7)`,
        [randomUUID(),org,channelId,conversation.id,event.upstreamMessageId,'content' in event?event.content:null,event.occurredAt,state]);
        return;
      }
    }
    const content:MessageContent='media' in event?{type:'MEDIA',mediaId:await registerPendingMedia(tx,org,channelId,event.media),
      kind:event.media.kind,fileName:event.media.fileName,caption:event.caption}:event.content;
    if(observed){await recordQrOutboundObservation(tx,{organizationId:org,channelId,conversationId:conversation.id,
      upstreamMessageId:event.upstreamMessageId,content,occurredAt:event.occurredAt});return;}
    await repository.recordIncoming(tx,{id:randomUUID(),organizationId:org,channelId,conversationId:conversation.id,
      webhookEventKey:`qr:${event.upstreamMessageId}`,upstreamMessageId:event.upstreamMessageId,content,occurredAt:event.occurredAt,
      ...(event.recoveredIdentity||event.historical?{scheduleBot:false}:{})});
  }
  const secret = (org: string, channel: string) =>
    createHmac("sha256", options.signingKey)
      .update(`qr-webhook\0${org}\0${channel}`)
      .digest("base64url");
  async function instance(channel: MessagingChannel) {
    if (channel.provider !== "BAILEYS" || !channel.instanceId)
      throw error("QR_INSTANCE_NOT_FOUND", 404);
    return options.transact(channel.organizationId, async (tx) => {
      const row = (
        await tx.query<{ upstream_instance_key: string; status: string }>(
          "SELECT upstream_instance_key,status FROM instances WHERE organization_id=$1 AND id=$2 AND provider_account_id=$3",
          [
            channel.organizationId,
            channel.instanceId,
            channel.providerAccountId,
          ],
        )
      ).rows[0];
      if (!row) throw error("QR_INSTANCE_NOT_FOUND", 404);
      return row;
    });
  }
  return {
    async runIdentityOnce(org:string){
      const due=await options.transact(org,async tx=>(await tx.query<{channel_id:string;upstream_instance_key:string}>(`SELECT p.channel_id,i.upstream_instance_key
        FROM qr_identity_pending_events p JOIN qr_identity_scopes s ON s.organization_id=p.organization_id AND s.channel_id=p.channel_id AND s.scope_id=p.scope_id
        JOIN qr_contact_aliases a ON a.organization_id=p.organization_id AND a.channel_id=p.channel_id AND a.scope_id=p.scope_id AND a.lid=p.lid AND a.status='CONFIRMED'
        JOIN messaging_channels c ON c.organization_id=p.organization_id AND c.id=p.channel_id AND c.instance_id=s.instance_id
        JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id AND i.upstream_instance_key=s.upstream_instance_key
        JOIN organizations o ON o.id=p.organization_id AND o.status='ACTIVE'
        WHERE p.organization_id=$1 AND p.status='WAITING' AND c.deleting_at IS NULL AND i.archived_at IS NULL AND i.status='CONNECTED'
        ORDER BY p.occurred_at,p.provider_message_id LIMIT 1`,[org])).rows[0]);
      if(!due)return{processed:0};
      const engine=await options.fleet?.capture(org,due.upstream_instance_key);
      return options.transact(org,async tx=>{
        await lockAttendanceChannel(tx,org,due.channel_id);await requireActiveOrganization(tx,org);
        if(engine)await options.fleet!.assert(engine,tx,true);
        const channel=await repository.findChannel(tx,org,due.channel_id);if(!channel||channel.provider!=='BAILEYS'||!channel.instanceId)return{processed:0};
        const fingerprint=bindingFingerprint(engine);
        const previous=(await tx.query<{binding_fingerprint:string}>('SELECT binding_fingerprint FROM qr_identity_scopes WHERE organization_id=$1 AND channel_id=$2',[org,channel.id])).rows[0];
        if(previous&&previous.binding_fingerprint!==fingerprint){
          await observeQrIdentityScope(tx,{organizationId:org,channelId:channel.id,instanceId:channel.instanceId,instanceKey:due.upstream_instance_key,
            signingKey:options.signingKey,bindingFingerprint:fingerprint},undefined,true);
          return{processed:0};
        }
        const recovered=await recoverQrIdentityEvents(tx,{organizationId:org,channelId:channel.id,bindingFingerprint:fingerprint});
        for(const event of recovered)await persistContactEvent(tx,channel,event);
        return{processed:recovered.length};
      });
    },
    async captureBinding(channel:MessagingChannel){
      if(!options.fleet)return undefined;
      const info=await instance(channel),snapshot=await options.fleet.capture(channel.organizationId,info.upstream_instance_key);
      return{assert:(tx:TenantTransaction)=>options.fleet!.assert(snapshot,tx,true)};
    },
    async activate(org: string, instanceId: string) {
      const channel = await options.transact(org, (tx) =>
        ensureQrChannel(tx, org, instanceId),
      );
      const info = await instance(channel);
      const client = options.fleet ? await options.fleet.messaging(org,info.upstream_instance_key) : new EvolutionMessagingClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        instanceKey: info.upstream_instance_key,
      });
      const webhookUrl = new URL(
        `/v1/webhooks/whatsapp/${channel.id}`,
        options.webhookOrigin,
      ).toString();
      const authority=options.fleet?await options.fleet.webhook(org,info.upstream_instance_key,channel.id):undefined;
      await client.configureWebhook(webhookUrl, authority?.token??secret(org, channel.id));
      if(authority)await options.transact(org,tx=>authority.assert(tx));
      return {
        id: channel.id,
        provider: "BAILEYS" as const,
        ownerRevision: channel.ownerRevision ?? 0,
        botPublicId: channel.botPublicId,
      };
    },
    async resolveClient(channel: MessagingChannel,claim?:OutboxClaim) {
      await options.identity?.refreshForDispatch(channel.organizationId, channel.id);
      const info = await instance(channel);
      if (info.status !== "CONNECTED") throw error("QR_CHANNEL_DISCONNECTED");
      return options.fleet ? options.fleet.messaging(channel.organizationId,info.upstream_instance_key,claim?{kind:'QR_DISPATCH',messageId:claim.message.id,leaseToken:claim.leaseToken}:undefined) : new EvolutionMessagingClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        instanceKey: info.upstream_instance_key,
      });
    },
    async downloadMedia(channel: MessagingChannel, messageId: string) {
      const info = await instance(channel);
      return (options.fleet ? await options.fleet.messaging(channel.organizationId,info.upstream_instance_key) : new EvolutionMessagingClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        instanceKey: info.upstream_instance_key,
      })).downloadMedia(messageId);
    },
    async ingest(
      channelId: string,
      authorization: string | undefined,
      payload: unknown,
    ) {
      const binding = await options.resolveChannel(channelId);
      if (!binding) throw error("QR_WEBHOOK_UNAUTHORIZED", 401);
      const authority=options.fleet?await options.transact(binding.organizationId,async tx=>{
        const row=(await tx.query<{upstream_instance_key:string}>('SELECT upstream_instance_key FROM instances WHERE organization_id=$1 AND id=$2',[binding.organizationId,binding.instanceId])).rows[0];
        if(!row)throw error('QR_WEBHOOK_UNAUTHORIZED',401);return row;
      }).then(async row=>{
        const snapshot=await options.fleet!.capture(binding.organizationId,row.upstream_instance_key);
        return{...await options.fleet!.webhook(binding.organizationId,row.upstream_instance_key,channelId),snapshot};
      }):undefined;
      const expected = Buffer.from(
        `Bearer ${authority?.token??secret(binding.organizationId, channelId)}`,
      );
      const received = Buffer.from(authorization ?? "");
      if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
      )
        throw error("QR_WEBHOOK_UNAUTHORIZED", 401);
      await options.transact(binding.organizationId, async (tx) => {
        await authority?.assert(tx);
        if(authority?.snapshot)await options.fleet!.assert(authority.snapshot,tx);
        const channel = await repository.findChannel(
          tx,
          binding.organizationId,
          channelId,
        );
        const row = (
          await tx.query<{ upstream_instance_key: string }>(
            "SELECT upstream_instance_key FROM instances WHERE organization_id=$1 AND id=$2",
            [binding.organizationId, binding.instanceId],
          )
        ).rows[0];
        if (!channel || !row || channel.instanceId !== binding.instanceId)
          throw error("QR_WEBHOOK_UNAUTHORIZED", 401);
        const envelope=payload&&typeof payload==='object'?payload as Record<string,unknown>:{};
        const historical=String(envelope.event).toLowerCase().replace(/_/gu,'.')==='messages.set';
        let events=historical?normalizeQrHistoryEvent(payload,row.upstream_instance_key):normalizeQrEvent(payload,row.upstream_instance_key);
        if(authority?.reconciliationOnly&&events.some(event=>!['status','group-status'].includes(event.kind)))throw error('EVOLUTION_ENGINE_DISABLED',409);
        const ownerPhone=qrPhone(envelope.sender);
        // Acquire the exclusive lock before any per-message read lock in a mixed batch.
        // Otherwise two incoming/outgoing batches could both try to upgrade a SHARE lock.
        if(historical||ownerPhone||events.some(event=>['connection','group','group-text','group-status','outbound','outbound-media','status','identity-pending'].includes(event.kind)||'lid' in event&&event.lid)) {
          await lockAttendanceChannel(tx,binding.organizationId,channelId);
          const current = (await tx.query<{ upstream_instance_key: string }>(`SELECT i.upstream_instance_key FROM messaging_channels c
            JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
            WHERE c.organization_id=$1 AND c.id=$2 AND c.instance_id=$3 AND i.archived_at IS NULL`,
            [binding.organizationId,channelId,binding.instanceId])).rows[0];
          if (!current || current.upstream_instance_key !== row.upstream_instance_key)
            throw error('QR_WEBHOOK_UNAUTHORIZED',401);
        }
        const identityInput={organizationId:binding.organizationId,channelId,instanceId:binding.instanceId,
          instanceKey:row.upstream_instance_key,signingKey:options.signingKey,bindingFingerprint:bindingFingerprint(authority?.snapshot)};
        for(const event of events)if(event.kind==='connection'&&event.state==='CONNECTED')
          await observeQrIdentityScope(tx,identityInput,event.identity,true);
        events=await resolveQrIdentityEvents(tx,identityInput,events,ownerPhone);
        const groupEvents=events.filter(event=>event.kind==='group');
        if(groupEvents.length)await options.groups?.ingest(tx,binding.organizationId,channelId,groupEvents);
        for (const event of events) {
          if(event.kind==='group')continue;
          if(event.kind==='group-text'||event.kind==='group-status') {
            // A group JID and its participant are never converted to a contact/phone.
            // Persist the authenticated fact in this transaction before acknowledging it.
            if(!options.groupAutomation) throw error('GROUP_RUNTIME_UNAVAILABLE',503);
            await options.groupAutomation.ingestWithinTransaction(tx,binding.organizationId,channelId,event);
            continue;
          }
          if (event.kind === "connection") {
            await options.groups?.observeConnection(tx,binding.organizationId,channelId,{connected:event.state==='CONNECTED',phone:event.identity??null});
            await options.identity?.observe(tx, binding.organizationId, channelId, { connected: event.state === 'CONNECTED', phone: event.identity ?? null });
            await tx.query(
              "UPDATE instances SET status=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 AND status NOT IN ('PROVISIONING','PROVISIONING_FAILED')",
              [binding.organizationId, binding.instanceId, event.state],
            );
            continue;
          }
          if (event.kind === "status") {
            await repository.recordStatusEvent(tx, {
              organizationId: binding.organizationId,
              channelId,
              upstreamMessageId: event.upstreamMessageId,
              state: event.state,
            });
            continue;
          }
          if(event.kind==='identity-pending')throw error('QR_IDENTITY_UNEXPECTED');
          await persistContactEvent(tx,channel,event);
        }
      });
    },
  };
}
