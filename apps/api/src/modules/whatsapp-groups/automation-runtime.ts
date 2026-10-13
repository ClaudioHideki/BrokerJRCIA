import type {EvolutionFleetRuntime} from '../evolution-fleet/runtime.js';
import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {QrEvent} from '../messaging/qr-events.js';
import type {ProviderContext} from '@jrc/providers';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {lockAttendanceChannel} from '../attendance/repository.js';
import {createEventRouter,createExecutionService} from '../automations/service.js';
import {createPostgresAutomationRepository} from '../automations/repository.js';
import {createPostgresMessagingRepository} from '../messaging/repository.js';
import {beginQrDispatchAttempt,recordQrOutboundObservation,recoverQrOutboundObservations,listQrDispatchAttempts,listQrOutboundObservations,abandonQrDispatchAttempt,abandonQrOutboundObservation} from '../messaging/qr-outbound-observation.js';
import {groupAuthorityAllows,currentGroupWebhookBinding} from './automation-authority.js';
import {readGroupHumanDispatch} from './central-group-dispatch.js';
import {readChatwootAttendanceGate} from '../attendance/control-service.js';
import {hasAmbiguousGroupProviderId} from './provider-scope.js';
import {canAdvanceMessageState,lockMessageStatusKey} from '../messaging/message-state.js';
import {AUTOMATION_ORIGIN,type AbandonQrDispatchAttemptRequest,type AbandonQrOutboundObservationRequest} from '@jrc/contracts';
import {WhatsAppGroupAutomationViewSchema,type WhatsAppGroupAutomationView} from '@jrc/contracts';
export interface GroupPrincipal {organizationId:string;actorId:string}
export interface GroupControlInput {groupJid:string;triggerText:string;expectedOwnerRevision:number;expectedBindingId:string;
  expectedBindingRevision:number;expectedIdentityRevision:number;expectedIdentityFingerprint:string;expectedRevision?:number|undefined}
export interface GroupRuntimeOptions {
  captureBinding?:EvolutionFleetRuntime['capture'];assertBinding?:EvolutionFleetRuntime['assert'];
  encryptionKey:string;configurationScope:string;requestTimeoutMs?:number;enabled?:boolean;runtimeReady?(organizationId:string):Promise<boolean>;
  refreshCatalogs?(organizationId:string):Promise<unknown>;
  transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
  /** Identity and groupsIgnore must be observed from the same trusted workspace
   * response, never supplied by a tenant/client or inferred from an event. */
  readIdentity(context:ProviderContext,instanceKey:string):Promise<{connected:boolean;phone:string|null;groupsIgnore:boolean|null}>;
  sendText(context:ProviderContext,instanceKey:string,recipient:{kind:'GROUP';groupJid:string},text:string):Promise<{upstreamMessageId:string}>;
}
export class GroupRuntimeError extends Error {
  constructor(readonly code:string,readonly diagnostics:Array<{nodeId:string;type:string}>=[]){super(code);}
}
type Control={conversation_id:string;group_jid:string;automation_id:string;version:number;binding_id:string;owner_revision:number;binding_revision:number;activated_at:Date;
  identity_revision:string;identity_fingerprint:string;revision:number;activation_revision:number;enabled:boolean;trigger_text:string;pause_reason:string|null;pause_actor_id:string|null};
const jid=(value:string)=>{if(!/^\d+(?:-\d+)?@g\.us$/u.test(value)||value.length>128)throw new GroupRuntimeError('GROUP_INVALID');return value;};
const normalizedAuthor=(value:string)=>value.replace(/:\d+(?=@)/u,''); // Device suffix only; PN and LID remain distinct.
export function createGroupAutomationRuntime(options:GroupRuntimeOptions) {
  const key=Buffer.from(options.encryptionKey,'base64');
  if(key.length!==32||key.toString('base64')!==options.encryptionKey||!options.configurationScope)throw new Error('INVALID_INTEGRATION_ENCRYPTION_KEY');
  const automation=createPostgresAutomationRepository(options),messaging=createPostgresMessagingRepository();
  const serviceOptions={transact:options.transact,repository:automation,messaging,enabled:options.enabled??true};
  const router=createEventRouter(serviceOptions),executor=createExecutionService(serviceOptions);
  const fingerprint=(org:string,channel:string,phone:string)=>createHmac('sha256',key).update(`whatsapp-group-identity:v1:${org}:${channel}:${phone}`).digest('hex');
  const ready=async(org:string)=>options.enabled!==false&&(!options.runtimeReady||await options.runtimeReady(org));
  const context=(org:string):ProviderContext=>{const ms=options.requestTimeoutMs??15000;return{organizationId:org,requestId:randomUUID(),deadline:new Date(Date.now()+ms),signal:AbortSignal.timeout(ms)};};
  const member=async(tx:TenantTransaction,p:GroupPrincipal,manage=true)=>{
    const row=(await tx.query<{role:string}>('SELECT role FROM lock_local_attendance_member($1)',[p.actorId])).rows[0];
    if(!row||!(manage?['OWNER','ADMIN']:['OWNER','ADMIN','OPERATOR']).includes(row.role))throw new GroupRuntimeError('GROUP_ACCESS_DENIED');
  };
  const control=async(tx:TenantTransaction,org:string,channel:string,group:string)=>(await tx.query<Control>(`SELECT * FROM whatsapp_group_automation_controls WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3 FOR UPDATE`,[org,channel,group])).rows[0];
  const authoritative=(tx:TenantTransaction,org:string,channel:string,g:Control)=>groupAuthorityAllows(tx,{organizationId:org,channelId:channel,conversationId:g.conversation_id,automationId:g.automation_id,version:g.version},options);
  const effectOriginCurrent=async(tx:TenantTransaction,org:string,message:string,g:Control)=>Boolean((await tx.query(`SELECT 1 FROM messaging_messages m
    JOIN automation_outbox o ON o.organization_id=m.organization_id AND o.remote_reference=m.id::text AND m.idempotency_key='automation:'||o.id::text
    JOIN automation_executions e ON e.organization_id=o.organization_id AND e.id=o.execution_id
    JOIN whatsapp_group_automation_sessions s ON s.organization_id=e.organization_id AND s.execution_id=e.id
    WHERE m.organization_id=$1 AND m.id=$2 AND m.source='AUTOMATION' AND m.conversation_id=$3
      AND o.kind='SEND_TEXT' AND o.status='SENT' AND e.status NOT IN ('CANCELED','FAILED','UNKNOWN')
      AND e.automation_id=$4 AND e.version=$5 AND e.binding_id=$6 AND e.channel_id=m.channel_id AND e.conversation_id=m.conversation_id
      AND s.activation_revision=$7 AND s.identity_revision=$8 AND s.identity_fingerprint=$9
      AND s.channel_id=m.channel_id AND s.conversation_id=m.conversation_id AND s.group_jid=$10
      AND m.provider_scope=whatsapp_group_provider_scope($1,$3)`,
    [org,message,g.conversation_id,g.automation_id,g.version,g.binding_id,g.activation_revision,g.identity_revision,g.identity_fingerprint,g.group_jid])).rowCount);
  const retireUndispatchedEffect=async(tx:TenantTransaction,org:string,message:string)=>{
    const locked=(await tx.query(`SELECT o.message_id FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id
      WHERE o.organization_id=$1 AND o.message_id=$2 AND m.state='ACCEPTED' AND o.lease_token IS NULL
        AND NOT EXISTS(SELECT 1 FROM qr_dispatch_attempts a WHERE a.organization_id=m.organization_id AND a.message_id=m.id)
      FOR UPDATE OF o SKIP LOCKED`,[org,message])).rowCount;
    if(!locked)return false;
    await tx.query("UPDATE messaging_messages SET state='FAILED',canonical_error_code='GROUP_EFFECT_AUTHORITY_REVOKED',updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND state='ACCEPTED'",[org,message]);
    await tx.query('DELETE FROM messaging_outbox WHERE organization_id=$1 AND message_id=$2 AND lease_token IS NULL',[org,message]);
    return true; // No dispatch marker ever existed; uncertainty is never retired here.
  };
  const currentDeadline=async(tx:TenantTransaction,ctx:ProviderContext)=>{
    if(ctx.signal.aborted||!(await tx.query<{current:boolean}>('SELECT clock_timestamp()<$1::timestamptz AS current',[ctx.deadline])).rows[0]?.current)throw new GroupRuntimeError('GROUP_RUNTIME_UNAVAILABLE');
  };
  const identityCurrent=(org:string,channel:string,g:{identity_fingerprint:string},observed:{connected:boolean;phone:string|null;groupsIgnore:boolean|null})=>
    observed.connected&&observed.groupsIgnore===false&&observed.phone!==null&&/^[1-9]\d{6,14}$/u.test(observed.phone)&&fingerprint(org,channel,observed.phone)===g.identity_fingerprint;
  const workspace=async(org:string,channel:string)=>options.transact(org,async tx=>{
    const row=(await tx.query<{instance_id:string;instance_key:string}>(`SELECT i.id AS instance_id,i.upstream_instance_key AS instance_key FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
      WHERE c.organization_id=$1 AND c.id=$2 AND c.provider='BAILEYS' AND c.deleting_at IS NULL AND i.archived_at IS NULL`,[org,channel])).rows[0];
    if(!row)throw new GroupRuntimeError('GROUP_CHANNEL_UNAVAILABLE');return row;
  });
  const sameWorkspace=async(tx:TenantTransaction,org:string,channel:string,observed:{instance_id:string;instance_key:string})=>{
    if(!(await tx.query(`SELECT 1 FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
      WHERE c.organization_id=$1 AND c.id=$2 AND i.id=$3 AND i.upstream_instance_key=$4`,[org,channel,observed.instance_id,observed.instance_key])).rowCount)
      throw new GroupRuntimeError('GROUP_WORKSPACE_CHANGED');
  };
  const viewWithin=async(tx:TenantTransaction,org:string,channel:string,group:string)=>{
    const g=await control(tx,org,channel,group);if(!g)throw new GroupRuntimeError('GROUP_NOT_ENABLED');
    const current=(await tx.query<{initiator_jid:string}>(`SELECT initiator_jid FROM whatsapp_group_automation_sessions WHERE organization_id=$1 AND conversation_id=$2 ORDER BY started_at DESC LIMIT 1`,[org,g.conversation_id])).rows[0];
    const subject=(await tx.query<{subject:string}>(`SELECT subject FROM whatsapp_group_catalog_items WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3`,[org,channel,group])).rows[0]?.subject??group;
    return {recipient:{kind:'GROUP' as const,groupJid:group},conversationId:g.conversation_id,contact:null,subject,sessionPolicy:'INITIATOR_ONLY' as const,
      revision:g.revision,enabled:g.enabled,pauseReason:g.pause_reason,pauseActorId:g.pause_actor_id,initiatorJid:current?.initiator_jid??null,automaticResend:false as const,
      attempts:(await listQrDispatchAttempts(tx,org,g.conversation_id)).data,observations:(await listQrOutboundObservations(tx,org,g.conversation_id)).data};
  };
  return {
    async refreshCatalogsOnce(org:string){if(!await ready(org))return{processed:false};return options.refreshCatalogs?options.refreshCatalogs(org):{processed:false};},
    /** A read-only operational projection. It never enables a group, changes
     * provider settings or treats a previously displayed revision as authority. */
    async inspect(principal:GroupPrincipal,channel:string,group:string):Promise<WhatsAppGroupAutomationView>{
      const org=principal.organizationId;jid(group);
      const snapshot=()=>options.transact(org,async tx=>{
        await member(tx,principal,false);
        const row=(await tx.query<any>(`/* GROUP_OPERATIONAL_VIEW */
          SELECT t.status AS organization_status,f.enabled AS feature_enabled,c.provider,c.transport,
            c.deleting_at IS NOT NULL OR i.archived_at IS NOT NULL AS deleting,i.id AS instance_id,i.upstream_instance_key AS instance_key,
            i.status='CONNECTED' AS connected,item.subject,item.selected,item.announce,item.is_community,item.is_community_announce,
            k.last_error_code IS NULL AND k.lease_token IS NULL AND k.valid_until>clock_timestamp() AS catalog_current,
            k.identity_revision,k.identity_fingerprint,
            p.own_state='PRESENT_FROM_CATALOG' AND p.identity_fingerprint=k.identity_fingerprint AND p.source_snapshot_id=k.snapshot_id AS own_present,
            w.phase='CONFIRMED' AND w.identity_revision=k.identity_revision AND w.identity_fingerprint=k.identity_fingerprint AS webhook_current,
            w.instance_id AS webhook_instance_id,w.binding_fingerprint AS webhook_binding_fingerprint,
            b.id AS binding_id,b.revision AS binding_revision,b.automation_id,b.version,d.name AS automation_name,o.revision AS owner_revision,
            o.executor='BROKER' AND o.remote_binding_id IS NULL AND o.automation_id=b.automation_id AND o.version=b.version
              AND c.bot_public_id=b.automation_id::text AND c.bot_origin_reference=$4
              AND b.status='ACTIVE' AND d.lifecycle_status='PUBLISHED' AND d.active_version=b.version AS flow_current,
            v.graph->'nodes' AS nodes,g.conversation_id,g.revision,g.trigger_text,g.enabled,g.pause_reason,
            g.identity_revision AS control_identity_revision,g.identity_fingerprint AS control_identity_fingerprint,
            g.binding_id AS control_binding_id,g.binding_revision AS control_binding_revision,g.owner_revision AS control_owner_revision,
            s.initiator_jid
          FROM messaging_channels c JOIN organizations t ON t.id=c.organization_id
          LEFT JOIN flow_features f ON f.organization_id=c.organization_id
          LEFT JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
          LEFT JOIN whatsapp_group_catalogs k ON k.organization_id=c.organization_id AND k.channel_id=c.id
          LEFT JOIN whatsapp_group_catalog_items item ON item.organization_id=c.organization_id AND item.channel_id=c.id AND item.group_jid=$3
          LEFT JOIN whatsapp_group_participation p ON p.organization_id=c.organization_id AND p.channel_id=c.id AND p.group_jid=$3 AND p.identity_revision=k.identity_revision
          LEFT JOIN attendance_owners o ON o.organization_id=c.organization_id AND o.channel_id=c.id
          LEFT JOIN automation_bindings b ON b.organization_id=c.organization_id AND b.channel_id=c.id AND b.status='ACTIVE'
          LEFT JOIN automation_definitions d ON d.organization_id=b.organization_id AND d.id=b.automation_id
          LEFT JOIN automation_versions v ON v.organization_id=b.organization_id AND v.automation_id=b.automation_id AND v.version=b.version
          LEFT JOIN whatsapp_group_automation_controls g ON g.organization_id=c.organization_id AND g.channel_id=c.id AND g.group_jid=$3
          LEFT JOIN LATERAL(SELECT phase,identity_revision,identity_fingerprint,instance_id,binding_fingerprint FROM whatsapp_group_webhook_operations
            WHERE organization_id=c.organization_id AND channel_id=c.id ORDER BY (phase IN ('PREPARED','DISPATCHED','UNKNOWN')) DESC,created_at DESC,id DESC LIMIT 1) w ON true
          LEFT JOIN LATERAL(SELECT initiator_jid FROM whatsapp_group_automation_sessions WHERE organization_id=c.organization_id
            AND conversation_id=g.conversation_id AND closed_at IS NULL ORDER BY started_at DESC LIMIT 1) s ON true
          WHERE c.organization_id=$1 AND c.id=$2`,[org,channel,group,AUTOMATION_ORIGIN])).rows[0];
        if(!row)throw new GroupRuntimeError('GROUP_CHANNEL_UNAVAILABLE');
        const expectedWebhookBinding=createHmac('sha256',key).update('whatsapp-group-webhook-binding:v2\0')
          .update(JSON.stringify([options.configurationScope,org,channel,row.instance_id,row.instance_key])).digest('hex');
        row.webhook_current=row.webhook_current===true&&row.webhook_instance_id===row.instance_id&&row.webhook_binding_fingerprint===expectedWebhookBinding;
        const attempts=row.conversation_id?(await listQrDispatchAttempts(tx,org,row.conversation_id)).data:[];
        const observations=row.conversation_id?(await listQrOutboundObservations(tx,org,row.conversation_id)).data:[];
        const current=row.conversation_id?await control(tx,org,channel,group):null;
        const allowed=current?await authoritative(tx,org,channel,current):false;
        return{row,attempts,observations,allowed};
      });
      const first=await snapshot();let current=first,observed:Awaited<ReturnType<GroupRuntimeOptions['readIdentity']>>|null=null,changed=false;
      if(first.row.provider==='BAILEYS'&&first.row.transport==='BROKER_TRANSPORT'&&first.row.connected&&!first.row.deleting
        &&first.row.catalog_current&&first.row.selected&&first.row.instance_key){
        try{observed=await options.readIdentity(context(org),first.row.instance_key);}catch{observed=null;}
        current=await snapshot();changed=current.row.instance_id!==first.row.instance_id||current.row.instance_key!==first.row.instance_key;
      }
      const r=current.row,supported=Array.isArray(r.nodes)&&r.nodes.every((n:{type:string})=>['start','message','menu','end'].includes(n.type));
      const flow=r.binding_id&&r.automation_id&&r.version&&r.owner_revision!==null?{automationId:r.automation_id,name:r.automation_name,
        version:r.version,bindingId:r.binding_id,bindingRevision:r.binding_revision,ownerRevision:r.owner_revision,supported}:null;
      const identity=r.identity_revision&&r.identity_fingerprint?{revision:Number(r.identity_revision),fingerprint:r.identity_fingerprint}:null;
      const configured=r.revision?{revision:r.revision,enabled:r.enabled,triggerText:r.trigger_text,pauseReason:r.pause_reason}:null;
      let nextAction:WhatsAppGroupAutomationView['nextAction']='ENABLE_GROUP_AUTOMATION',state:WhatsAppGroupAutomationView['state']='SETUP_REQUIRED';
      const uncertain=current.attempts.some(a=>a.state==='DISPATCHED'||a.state==='UNKNOWN')||current.observations.some(a=>a.blocking);
      if(r.provider!=='BAILEYS'||r.transport!=='BROKER_TRANSPORT')nextAction='UNSUPPORTED_TRANSPORT';
      else if(!r.connected||r.deleting)nextAction='CONNECT_WHATSAPP';
      else if(!r.catalog_current||!identity||!r.own_present)nextAction='UPDATE_GROUPS';
      else if(!r.selected)nextAction='SELECT_GROUP';
      else if(r.announce===true||r.is_community===true||r.is_community_announce===true)nextAction='UNSUPPORTED_GROUP';
      else if(r.announce!==false||r.is_community!==false||r.is_community_announce!==false)nextAction='UPDATE_GROUPS';
      else if(changed)nextAction='REVALIDATE_GROUP';
      else if(!r.webhook_current)nextAction='CONFIGURE_EVENTS';
      else if(!observed?.connected||!observed.phone||!identityCurrent(org,channel,{identity_fingerprint:identity.fingerprint},observed))
        nextAction=observed?.connected&&observed.phone&&/^[1-9]\d{6,14}$/u.test(observed.phone)&&observed.groupsIgnore===true?'ALLOW_GROUP_MESSAGES':'UPDATE_GROUPS';
      else if(!flow||!r.flow_current||r.organization_status!=='ACTIVE'||!r.feature_enabled||!await ready(org))nextAction='PUBLISH_AND_BIND_FLOW';
      else if(!supported)nextAction='CHOOSE_SUPPORTED_FLOW';
      else if(uncertain){nextAction='RECONCILE_OUTCOME';state='UNKNOWN';}
      else if(configured?.enabled){
        if(configured.pauseReason){nextAction='RESUME_GROUP';state='PAUSED';}
        else if(!current.allowed){nextAction='REVALIDATE_GROUP';state='PAUSED';}
        else {nextAction='READY';state='ACTIVE';}
      }
      return WhatsAppGroupAutomationViewSchema.parse({schemaVersion:1,organizationId:org,channelId:channel,groupJid:group,
        subject:r.subject??group,capability:r.provider==='BAILEYS'&&r.transport==='BROKER_TRANSPORT'?'QR_TEXT':'UNSUPPORTED',
        state,nextAction,flow,identity,control:configured,initiatorJid:r.initiator_jid??null,attempts:current.attempts,observations:current.observations});
    },
    async configure(principal:GroupPrincipal,channel:string,input:GroupControlInput){
      const org=principal.organizationId,group=jid(input.groupJid);
      if(!input.triggerText.trim()||input.triggerText.length>64)throw new GroupRuntimeError('GROUP_TRIGGER_INVALID');
      if(!await ready(org))throw new GroupRuntimeError('GROUP_RUNTIME_UNAVAILABLE');
      await options.transact(org,tx=>member(tx,principal));
      const ctx=context(org),instance=await workspace(org,channel),engine=await options.captureBinding?.(org,instance.instance_key),observed=await options.readIdentity(ctx,instance.instance_key);
      if(observed.groupsIgnore!==false)throw new GroupRuntimeError('GROUP_TRANSPORT_IGNORED');
      if(!identityCurrent(org,channel,{identity_fingerprint:input.expectedIdentityFingerprint},observed))throw new GroupRuntimeError('GROUP_IDENTITY_CHANGED');
      if(!await ready(org)||ctx.signal.aborted||ctx.deadline.getTime()<=Date.now())throw new GroupRuntimeError('GROUP_RUNTIME_UNAVAILABLE');
      return options.transact(org,async tx=>{
        await member(tx,principal);await lockAttendanceChannel(tx,org,channel);
        await sameWorkspace(tx,org,channel,instance);
        if(engine)await options.assertBinding!(engine,tx,true);
        await currentDeadline(tx,ctx);
        const webhookBinding=await currentGroupWebhookBinding(tx,org,channel,options);
        const webhook=(await tx.query<{phase:string;binding_fingerprint:string}>(`SELECT phase,binding_fingerprint FROM whatsapp_group_webhook_operations WHERE organization_id=$1 AND channel_id=$2
          ORDER BY (phase IN ('PREPARED','DISPATCHED','UNKNOWN')) DESC,created_at DESC,id DESC LIMIT 1`,[org,channel])).rows[0];
        if(!webhookBinding||webhook?.phase!=='CONFIRMED'||webhook.binding_fingerprint!==webhookBinding)throw new GroupRuntimeError('GROUP_WEBHOOK_CHANGED');
        const bound=(await tx.query<{id:string;automation_id:string;version:number;revision:number;owner_revision:number;graph:{nodes:Array<{id:string;type:string}>}}>(`SELECT b.id,b.automation_id,b.version,b.revision,o.revision AS owner_revision,v.graph FROM automation_bindings b
          JOIN attendance_owners o ON o.organization_id=b.organization_id AND o.channel_id=b.channel_id
          JOIN automation_versions v ON v.organization_id=b.organization_id AND v.automation_id=b.automation_id AND v.version=b.version
          WHERE b.organization_id=$1 AND b.channel_id=$2 AND b.id=$3 AND b.status='ACTIVE' AND o.executor='BROKER' AND o.automation_id=b.automation_id AND o.version=b.version FOR UPDATE OF b,o`,[org,channel,input.expectedBindingId])).rows[0];
        if(!bound||bound.revision!==input.expectedBindingRevision||bound.owner_revision!==input.expectedOwnerRevision)throw new GroupRuntimeError('GROUP_AUTHORITY_CHANGED');
        const unsupported=bound.graph.nodes.filter(n=>!['start','message','menu','end'].includes(n.type)).map(n=>({nodeId:n.id,type:n.type}));
        if(unsupported.length)throw new GroupRuntimeError('GROUP_NODE_UNSUPPORTED',unsupported);
        const catalog=(await tx.query<{identity_revision:string;identity_fingerprint:string}>(`SELECT identity_revision,identity_fingerprint FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE`,[org,channel])).rows[0];
        if(!catalog||Number(catalog.identity_revision)!==input.expectedIdentityRevision||catalog.identity_fingerprint!==input.expectedIdentityFingerprint)throw new GroupRuntimeError('GROUP_IDENTITY_CHANGED');
        const existing=await control(tx,org,channel,group);
        if(existing&&(input.expectedRevision!==existing.revision))throw new GroupRuntimeError('GROUP_CONTROL_CHANGED');
        if(existing&&(await tx.query(`SELECT 1 FROM whatsapp_group_automation_sessions WHERE organization_id=$1 AND conversation_id=$2 AND closed_at IS NULL`,[org,existing.conversation_id])).rowCount)throw new GroupRuntimeError('GROUP_SESSION_ACTIVE');
        // Every binding/owner/catalog/control lock has now been acquired. A
        // pre-lock projection is not authority to activate after this deadline.
        await currentDeadline(tx,ctx);
        const conversation=(await tx.query<{id:string}>(`INSERT INTO messaging_conversations(organization_id,channel_id,recipient_kind,group_jid,contact_id,mode)
          VALUES($1,$2,'GROUP',$3,NULL,'BOT') ON CONFLICT(organization_id,channel_id,group_jid) WHERE recipient_kind='GROUP' DO UPDATE SET group_jid=EXCLUDED.group_jid RETURNING id`,[org,channel,group])).rows[0]!;
        const g=(await tx.query<Control>(`INSERT INTO whatsapp_group_automation_controls(organization_id,channel_id,group_jid,conversation_id,binding_id,automation_id,version,owner_revision,binding_revision,
          identity_revision,identity_fingerprint,trigger_text,enabled,configured_by,webhook_binding_fingerprint)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14) ON CONFLICT(organization_id,channel_id,group_jid) DO UPDATE SET
          binding_id=EXCLUDED.binding_id,automation_id=EXCLUDED.automation_id,version=EXCLUDED.version,owner_revision=EXCLUDED.owner_revision,binding_revision=EXCLUDED.binding_revision,
          identity_revision=EXCLUDED.identity_revision,identity_fingerprint=EXCLUDED.identity_fingerprint,trigger_text=EXCLUDED.trigger_text,enabled=true,pause_reason=NULL,pause_actor_id=NULL,
          webhook_binding_fingerprint=EXCLUDED.webhook_binding_fingerprint,configured_by=EXCLUDED.configured_by,activated_at=clock_timestamp(),revision=whatsapp_group_automation_controls.revision+1,
          activation_revision=whatsapp_group_automation_controls.activation_revision+1,updated_at=clock_timestamp() RETURNING *`,
          [org,channel,group,conversation.id,bound.id,bound.automation_id,bound.version,bound.owner_revision,bound.revision,catalog.identity_revision,catalog.identity_fingerprint,input.triggerText.trim(),principal.actorId,webhookBinding])).rows[0]!;
        if(!await authoritative(tx,org,channel,g))throw new GroupRuntimeError('GROUP_AUTHORITY_CHANGED');
        await tx.query(`UPDATE automation_outbox o SET status='CANCELED',last_error='GROUP_EFFECT_AUTHORITY_REVOKED',updated_at=clock_timestamp()
          FROM whatsapp_group_automation_sessions s WHERE o.organization_id=$1 AND s.organization_id=o.organization_id AND s.execution_id=o.execution_id
            AND s.conversation_id=$2 AND s.activation_revision<>$3 AND o.status='PENDING' AND o.lease_token IS NULL`,[org,g.conversation_id,g.activation_revision]);
        await currentDeadline(tx,ctx);
        await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata)
          VALUES($1,$2,'GROUP_AUTOMATION_ENABLED','conversation',$3,$4,'SUCCESS',$5)`,[org,principal.actorId,g.conversation_id,randomUUID(),{sessionPolicy:'INITIATOR_ONLY',revision:g.revision}]);
        const view=await viewWithin(tx,org,channel,group);await currentDeadline(tx,ctx);return view;
      });
    },
    async pause(principal:GroupPrincipal,channel:string,group:string,revision:number){return options.transact(principal.organizationId,async tx=>{
      const org=principal.organizationId;await member(tx,principal);await lockAttendanceChannel(tx,org,channel);const g=await control(tx,org,channel,jid(group));
      if(!g||g.revision!==revision)throw new GroupRuntimeError('GROUP_CONTROL_CHANGED');
      await tx.query(`UPDATE whatsapp_group_automation_controls SET pause_reason='HUMAN_ACTION',pause_actor_id=$4,revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3`,[org,channel,group,principal.actorId]);
      await tx.query(`UPDATE messaging_conversations SET mode='HUMAN',attendance_revision=attendance_revision+1 WHERE organization_id=$1 AND id=$2`,[org,g.conversation_id]);
      await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata) VALUES($1,$2,'GROUP_HUMAN_PAUSED','conversation',$3,$4,'SUCCESS','{}')`,[org,principal.actorId,g.conversation_id,randomUUID()]);
      return viewWithin(tx,org,channel,group);
    });},
    async resume(principal:GroupPrincipal,channel:string,group:string,revision:number){
      const org=principal.organizationId;if(!await ready(org))throw new GroupRuntimeError('GROUP_RUNTIME_UNAVAILABLE');
      await options.transact(org,tx=>member(tx,principal));const ctx=context(org),instance=await workspace(org,channel),engine=await options.captureBinding?.(org,instance.instance_key),observed=await options.readIdentity(ctx,instance.instance_key);
      if(!await ready(org)||ctx.signal.aborted)throw new GroupRuntimeError('GROUP_RUNTIME_UNAVAILABLE');
      return options.transact(org,async tx=>{await member(tx,principal);await lockAttendanceChannel(tx,org,channel);const g=await control(tx,org,channel,jid(group));
        await sameWorkspace(tx,org,channel,instance);
        if(engine)await options.assertBinding!(engine,tx,true);
        await currentDeadline(tx,ctx);
        if(!g||g.revision!==revision)throw new GroupRuntimeError('GROUP_CONTROL_CHANGED');
        if(!identityCurrent(org,channel,g,observed))throw new GroupRuntimeError('GROUP_IDENTITY_CHANGED');
        if((await tx.query(`SELECT 1 FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('DISPATCHED','UNKNOWN') UNION ALL SELECT 1 FROM qr_outbound_observations WHERE organization_id=$1 AND conversation_id=$2 AND blocking`,[org,g.conversation_id])).rowCount)throw new GroupRuntimeError('GROUP_OUTCOME_UNKNOWN');
        await tx.query(`UPDATE whatsapp_group_automation_controls SET pause_reason=NULL,pause_actor_id=NULL,activated_at=clock_timestamp(),revision=revision+1 WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3`,[org,channel,group]);
        await tx.query(`UPDATE whatsapp_group_automation_sessions s SET control_revision=$3,closed_at=CASE WHEN e.status IN ('CANCELED','FAILED','COMPLETED') THEN clock_timestamp() ELSE s.closed_at END
          FROM automation_executions e WHERE s.organization_id=$1 AND s.conversation_id=$2 AND s.closed_at IS NULL AND e.organization_id=s.organization_id AND e.id=s.execution_id`,[org,g.conversation_id,g.revision+1]);
        await tx.query("UPDATE messaging_conversations SET mode='BOT',attendance_revision=attendance_revision+1 WHERE organization_id=$1 AND id=$2",[org,g.conversation_id]);
        const current=(await control(tx,org,channel,group))!;if(!await authoritative(tx,org,channel,current))throw new GroupRuntimeError('GROUP_AUTHORITY_CHANGED');
        await currentDeadline(tx,ctx);
        await tx.query(`INSERT INTO audit_logs(organization_id,actor_id,event_type,resource_type,resource_id,request_id,outcome,metadata) VALUES($1,$2,'GROUP_AUTOMATION_RESUMED','conversation',$3,$4,'SUCCESS','{}')`,[org,principal.actorId,g.conversation_id,randomUUID()]);
        const view=await viewWithin(tx,org,channel,group);await currentDeadline(tx,ctx);return view;
      });
    },
    view:(principal:GroupPrincipal,channel:string,group:string)=>options.transact(principal.organizationId,async tx=>{await member(tx,principal);return viewWithin(tx,principal.organizationId,channel,jid(group));}),
    async ingestWithinTransaction(tx:TenantTransaction,org:string,channel:string,event:Extract<QrEvent,{kind:'group-text'|'group-status'}>){
      await lockAttendanceChannel(tx,org,channel);jid(event.groupJid);
      if(event.kind==='group-status'){
        await lockMessageStatusKey(tx,org,channel,event.upstreamMessageId);
        const scope=(await tx.query<{scope:string}>(`SELECT 'g3:'||$3::text||':'||identity_revision::text AS scope FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2`,[org,channel,event.groupJid])).rows[0]?.scope;
        if(!scope)return{duplicate:false,executionId:null,reason:'GROUP_IDENTITY_REQUIRED'};
        const conversation=(await tx.query<{id:string}>(`SELECT id FROM messaging_conversations WHERE organization_id=$1 AND channel_id=$2 AND recipient_kind='GROUP' AND group_jid=$3`,[org,channel,event.groupJid])).rows[0];
        if(conversation&&await hasAmbiguousGroupProviderId(tx,{organizationId:org,channelId:channel,conversationId:conversation.id,providerId:event.upstreamMessageId,providerScope:scope})){
          await tx.query(`INSERT INTO messaging_status_events(organization_id,channel_id,provider_scope,upstream_message_id,state) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(organization_id,channel_id,provider_scope,upstream_message_id,state) DO NOTHING`,[org,channel,`g3-ambiguous:${event.groupJid}`,event.upstreamMessageId,event.state]);
          return{duplicate:false,executionId:null,reason:'GROUP_STATUS_IDENTITY_AMBIGUOUS'};
        }
        await tx.query(`INSERT INTO messaging_status_events(organization_id,channel_id,provider_scope,upstream_message_id,state) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(organization_id,channel_id,provider_scope,upstream_message_id,state) DO NOTHING`,[org,channel,scope,event.upstreamMessageId,event.state]);
        const messages=(await tx.query<{id:string;state:import('../messaging/types.js').MessageState}>(`SELECT m.id,m.state FROM messaging_messages m JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
          WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.upstream_message_id=$3 AND m.provider_scope=$5 AND m.direction='OUTGOING' AND c.recipient_kind='GROUP' AND c.group_jid=$4 FOR UPDATE OF m`,[org,channel,event.upstreamMessageId,event.groupJid,scope])).rows;
        for(const m of messages)if(canAdvanceMessageState(m.state,event.state))await tx.query('UPDATE messaging_messages SET state=$3,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2',[org,m.id,event.state]);
        return {duplicate:false,executionId:null,reason:null};
      }
      const identity=(await tx.query<{identity_revision:string;identity_fingerprint:string|null}>(`SELECT identity_revision,identity_fingerprint FROM whatsapp_group_catalogs WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE`,[org,channel])).rows[0];
      if(!identity?.identity_fingerprint)return{duplicate:false,executionId:null,reason:'GROUP_IDENTITY_REQUIRED'};
      const conversation=(await tx.query<{id:string}>(`INSERT INTO messaging_conversations(organization_id,channel_id,recipient_kind,group_jid,contact_id)
        VALUES($1,$2,'GROUP',$3,NULL) ON CONFLICT(organization_id,channel_id,group_jid) WHERE recipient_kind='GROUP' DO UPDATE SET group_jid=EXCLUDED.group_jid RETURNING id`,[org,channel,event.groupJid])).rows[0]!;
      const inserted=(await tx.query<{id:string}>(`INSERT INTO whatsapp_group_transport_facts(organization_id,channel_id,conversation_id,group_jid,identity_revision,identity_fingerprint,provider_message_id,from_me,participant_jid,participant_jid_alt,content,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(organization_id,channel_id,identity_revision,group_jid,provider_message_id,from_me) DO NOTHING RETURNING id`,
        [org,channel,conversation.id,event.groupJid,identity.identity_revision,identity.identity_fingerprint,event.upstreamMessageId,event.fromMe,event.participantJid,event.participantJidAlt,event.content,event.occurredAt])).rows[0];
      if(!inserted)return{duplicate:true,executionId:null,reason:null};
      const g=await control(tx,org,channel,event.groupJid);
      const ignored=async(reason:string)=>{await tx.query("UPDATE whatsapp_group_transport_facts SET disposition='IGNORED',reason=$3 WHERE organization_id=$1 AND id=$2",[org,inserted.id,reason]);return{duplicate:false,executionId:null,reason};};
      // The provider emits seconds, so use the database watermark at that same
      // precision. This rejects identified old history without claiming a live
      // marker or requiring a different customer interaction protocol.
      if(g&&event.occurredAt.getTime()<Math.floor(g.activated_at.getTime()/1000)*1000)return ignored('GROUP_BEFORE_ACTIVATION');
      const session=(await tx.query<{execution_id:string;initiator_jid:string;started_at:Date}>(`SELECT execution_id,initiator_jid,started_at FROM whatsapp_group_automation_sessions WHERE organization_id=$1 AND channel_id=$2 AND group_jid=$3 AND closed_at IS NULL FOR UPDATE`,[org,channel,event.groupJid])).rows[0];
      if(session&&event.occurredAt.getTime()<Math.floor(session.started_at.getTime()/1000)*1000)return ignored('GROUP_BEFORE_SESSION');
      if(event.fromMe){
        await recordQrOutboundObservation(tx,{organizationId:org,channelId:channel,conversationId:conversation.id,upstreamMessageId:event.upstreamMessageId,content:event.content,occurredAt:event.occurredAt});
        const observed=(await tx.query<{id:string;disposition:string;message_id:string|null}>(`SELECT id,disposition,message_id FROM qr_outbound_observations WHERE organization_id=$1 AND conversation_id=$2 AND provider_message_id=$3 AND provider_scope=whatsapp_group_provider_scope($1,$2)`,[org,conversation.id,event.upstreamMessageId])).rows[0]!;
        await tx.query(`UPDATE whatsapp_group_transport_facts SET disposition=$3,observation_id=$4,message_id=$5 WHERE organization_id=$1 AND id=$2`,[org,inserted.id,observed.disposition,observed.id,observed.message_id]);
        return{duplicate:false,executionId:null,reason:observed.disposition};
      }
      const message=(await messaging.recordIncoming(tx,{id:randomUUID(),organizationId:org,channelId:channel,conversationId:conversation.id,upstreamMessageId:event.upstreamMessageId,
        webhookEventKey:`group:${identity.identity_revision}:${event.groupJid}:${event.upstreamMessageId}`,content:event.content,occurredAt:event.occurredAt,scheduleBot:false})).message;
      await tx.query('UPDATE whatsapp_group_transport_facts SET message_id=$3 WHERE organization_id=$1 AND id=$2',[org,inserted.id,message.id]);
      if(!g?.enabled)return ignored('GROUP_NOT_ENABLED');if(g.pause_reason)return ignored('GROUP_PAUSED');
      if(!await ready(org)||!await authoritative(tx,org,channel,g))return ignored('GROUP_AUTHORITY_CHANGED');
      const participant=normalizedAuthor(event.participantJid!);
      if(session&&session.initiator_jid!==participant)return ignored('GROUP_OTHER_PARTICIPANT');
      if(!session&&event.content.text.trim()!==g.trigger_text)return ignored('GROUP_TRIGGER_REQUIRED');
      const routed=await router.routeWithinTransaction(tx,org,{channelId:channel,conversationId:conversation.id,eventKey:`group:${identity.identity_revision}:${event.groupJid}:${event.upstreamMessageId}`,
        text:event.content.text,payload:{text:event.content.text,groupJid:event.groupJid,participantJid:participant}});
      if(!routed.execution)return ignored('GROUP_NOT_ROUTED');
      if(!session)await tx.query(`INSERT INTO whatsapp_group_automation_sessions(organization_id,execution_id,channel_id,conversation_id,group_jid,initiator_jid,identity_revision,identity_fingerprint,control_revision,activation_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[org,routed.execution.id,channel,conversation.id,event.groupJid,participant,g.identity_revision,g.identity_fingerprint,g.revision,g.activation_revision]);
      await tx.query("UPDATE whatsapp_group_transport_facts SET disposition='ROUTED' WHERE organization_id=$1 AND id=$2",[org,inserted.id]);
      return{duplicate:false,executionId:routed.execution.id,reason:null};
    },
    async executeOnce(org:string){if(!await ready(org))return{processed:false};const result=await executor.runOnce(org);
      // The canonical administrative cancellation may happen outside this
      // worker. Mirror only its terminal fact, including an otherwise idle turn.
      await options.transact(org,tx=>tx.query(`UPDATE whatsapp_group_automation_sessions s SET closed_at=clock_timestamp() FROM automation_executions e
        WHERE s.organization_id=$1 AND e.organization_id=s.organization_id AND e.id=s.execution_id AND e.status IN ('COMPLETED','CANCELED','FAILED') AND s.closed_at IS NULL`,[org]));
      return result;
    },
    async enqueueEffectsOnce(org:string){if(!await ready(org))return{processed:false};return options.transact(org,async tx=>{
      const token=randomUUID(),item=await automation.claimOutbox(tx,org,token,120000,['SEND_TEXT'],'GROUP');if(!item)return{processed:false};
      const text=String(item.payload.text??'');if(!text||text.length>4096)throw new GroupRuntimeError('GROUP_TEXT_INVALID');
      const idempotencyKey=`automation:${item.id}`,bodyHash=createHash('sha256').update(JSON.stringify({conversationId:item.conversationId,text})).digest('hex');
      const message=(await tx.query<{id:string}>(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,content,state,idempotency_key,idempotency_body_hash)
        VALUES($1,$2,$3,$4,'OUTGOING','AUTOMATION',$5,'ACCEPTED',$6,$7) ON CONFLICT(organization_id,channel_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING id`,
        [randomUUID(),org,item.channelId,item.conversationId,{type:'TEXT',text},idempotencyKey,bodyHash])).rows[0]!;
      await tx.query('INSERT INTO messaging_outbox(organization_id,message_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[org,message.id]);
      await automation.settleOutbox(tx,org,item.id,token,{status:'SENT',remoteReference:message.id});
      return{processed:true,messageId:message.id};
    });},
    async dispatchOnce(org:string){
      if(options.runtimeReady&&!await options.runtimeReady(org))return{processed:false};
      await options.transact(org,tx=>recoverQrOutboundObservations(tx,org));
      const candidates=await options.transact(org,async tx=>(await tx.query<{id:string;source:string;channel_id:string;conversation_id:string;group_jid:string;instance_id:string;instance_key:string}>(`SELECT m.id,m.source,m.channel_id,m.conversation_id,c.group_jid,i.id AS instance_id,i.upstream_instance_key AS instance_key
        FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id
        JOIN messaging_conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
        JOIN messaging_channels ch ON ch.organization_id=m.organization_id AND ch.id=m.channel_id
        JOIN instances i ON i.organization_id=ch.organization_id AND i.id=ch.instance_id
        WHERE o.organization_id=$1 AND c.recipient_kind='GROUP' AND m.state='ACCEPTED' AND o.available_at<=clock_timestamp()
          AND (m.source='OPERATOR' OR $2::boolean)
          AND (o.lease_token IS NULL OR o.lease_expires_at<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM messaging_messages p WHERE p.organization_id=m.organization_id AND p.conversation_id=m.conversation_id
            AND p.direction='OUTGOING' AND p.sequence_number<m.sequence_number AND (p.state IN ('ACCEPTED','SENDING') OR
              p.state='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM qr_dispatch_attempts a WHERE a.organization_id=p.organization_id AND a.message_id=p.id AND a.state='ABANDONED')))
        ORDER BY o.available_at,m.sequence_number,m.id LIMIT 50`,[org,options.enabled!==false])).rows);
      const ctx=context(org);
      for(const candidate of candidates){
      const human=(tx:TenantTransaction)=>readGroupHumanDispatch(tx,{organizationId:org,channelId:candidate.channel_id,conversationId:candidate.conversation_id,messageId:candidate.id},options);
      const centralAllows=(tx:TenantTransaction)=>readChatwootAttendanceGate(tx,{organizationId:org,channelId:candidate.channel_id,conversationId:candidate.conversation_id});
      const defer=()=>options.transact(org,async tx=>{await lockAttendanceChannel(tx,org,candidate.channel_id);await tx.query(`UPDATE messaging_outbox SET available_at=clock_timestamp()+interval '5 seconds'
        WHERE organization_id=$1 AND message_id=$2 AND lease_token IS NULL`,[org,candidate.id]);});
      const local=await options.transact(org,async tx=>{await lockAttendanceChannel(tx,org,candidate.channel_id);const g=await control(tx,org,candidate.channel_id,candidate.group_jid);
        // A stale catalog or temporarily unavailable central identity must not
        // destroy an authenticated reply that has not been dispatched.
        if(candidate.source==='OPERATOR')return await human(tx)?'CURRENT':'BLOCKED';
        if(!g)return 'BLOCKED';
        if(!await effectOriginCurrent(tx,org,candidate.id,g))return await retireUndispatchedEffect(tx,org,candidate.id)?'RETIRED':'BLOCKED';
        return await authoritative(tx,org,candidate.channel_id,g)&&(await centralAllows(tx)).allowed?'CURRENT':'BLOCKED';
      });
      if(local==='RETIRED')return{processed:true,status:'FAILED',messageId:candidate.id};
      if(local!=='CURRENT'){await defer();continue;}
      let engine:Awaited<ReturnType<EvolutionFleetRuntime['capture']>>|undefined;
      let observed:Awaited<ReturnType<GroupRuntimeOptions['readIdentity']>>;
      try{engine=await options.captureBinding?.(org,candidate.instance_key);observed=await options.readIdentity(ctx,candidate.instance_key);}catch{await defer();if(ctx.signal.aborted)break;continue;}
      if((candidate.source!=='OPERATOR'&&!await ready(org))||ctx.signal.aborted||ctx.deadline.getTime()<=Date.now())break;
      const token=randomUUID();
      const dispatched=await options.transact(org,async tx=>{
        if(engine)await options.assertBinding!(engine,tx,true);
        await lockAttendanceChannel(tx,org,candidate.channel_id);const g=await control(tx,org,candidate.channel_id,candidate.group_jid);
        if(candidate.source==='OPERATOR'){
          const h=await human(tx);if(!h||!identityCurrent(org,candidate.channel_id,h,observed))return null;
        } else if(!g||!identityCurrent(org,candidate.channel_id,g,observed)||!await effectOriginCurrent(tx,org,candidate.id,g)||!await authoritative(tx,org,candidate.channel_id,g)||!(await centralAllows(tx)).allowed)return null;
        if(!(await tx.query(`SELECT 1 FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
          WHERE c.organization_id=$1 AND c.id=$2 AND i.id=$3 AND i.upstream_instance_key=$4`,[org,candidate.channel_id,candidate.instance_id,candidate.instance_key])).rowCount)return null;
        const reserved=(await tx.query(`SELECT o.message_id FROM messaging_outbox o JOIN messaging_messages m ON m.organization_id=o.organization_id AND m.id=o.message_id
          WHERE o.organization_id=$1 AND o.message_id=$2 AND m.state='ACCEPTED' AND (o.lease_token IS NULL OR o.lease_expires_at<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM messaging_messages p WHERE p.organization_id=m.organization_id AND p.conversation_id=m.conversation_id AND p.direction='OUTGOING' AND p.sequence_number<m.sequence_number
            AND (p.state IN ('ACCEPTED','SENDING') OR p.state='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM qr_dispatch_attempts a WHERE a.organization_id=p.organization_id AND a.message_id=p.id AND a.state='ABANDONED')))
          FOR UPDATE OF o SKIP LOCKED`,[org,candidate.id])).rowCount;if(!reserved)return null;
        const timing=(await tx.query<{current:boolean}>('SELECT clock_timestamp()<$1::timestamptz AS current',[ctx.deadline])).rows[0]!;
        if(!timing.current||ctx.signal.aborted)return null;
        await tx.query('UPDATE messaging_outbox SET lease_token=$3,lease_expires_at=$4,attempt_count=attempt_count+1 WHERE organization_id=$1 AND message_id=$2',[org,candidate.id,token,new Date(ctx.deadline.getTime()+1000)]);
        const message=(await tx.query<{content:{type:'TEXT';text:string}}>("UPDATE messaging_messages SET state='SENDING' WHERE organization_id=$1 AND id=$2 AND state='ACCEPTED' RETURNING content",[org,candidate.id])).rows[0];
        if(!message)throw new GroupRuntimeError('GROUP_CLAIM_CHANGED');
        await beginQrDispatchAttempt(tx,{organizationId:org,channelId:candidate.channel_id,conversationId:candidate.conversation_id,messageId:candidate.id,leaseToken:token});
        return message;
      });
      if(!dispatched){await defer();continue;}
      let outcome:Parameters<typeof messaging.completeSend>[1]['outcome'];
      try{ctx.signal.throwIfAborted();const receipt=await options.sendText({...ctx,engineIntent:{kind:'QR_DISPATCH',messageId:candidate.id,leaseToken:token}},candidate.instance_key,{kind:'GROUP',groupJid:candidate.group_jid},dispatched.content.text);
        if(!receipt.upstreamMessageId||receipt.upstreamMessageId.length>256)throw new Error('QR_SEND_UNKNOWN');outcome={state:'SENT',upstreamMessageId:receipt.upstreamMessageId};}
      catch(error){const code=(error as {code?:string;uncertain?:boolean})?.code;
        outcome=(error as {uncertain?:boolean})?.uncertain===false&&typeof code==='string'&&code.startsWith('EVOLUTION_ENGINE_')
          ?{state:'FAILED',canonicalErrorCode:code,retrySafe:code==='EVOLUTION_ENGINE_RETRY_LATER'}:{state:'UNKNOWN',canonicalErrorCode:'QR_SEND_UNKNOWN'};}
      try{await options.transact(org,async tx=>{if(outcome.state==='SENT'&&engine)await options.assertBinding!(engine,tx,true);await messaging.completeSend(tx,{organizationId:org,messageId:candidate.id,leaseToken:token,outcome});});}
      catch{return{processed:true,status:'UNKNOWN',messageId:candidate.id};} // Lost commit receipt is never replay permission.
      return{processed:true,status:outcome.state,messageId:candidate.id};
      }
      return{processed:false};
    },
    async abandonAttempt(principal:GroupPrincipal,channel:string,group:string,id:string,input:AbandonQrDispatchAttemptRequest){return options.transact(principal.organizationId,async tx=>{
      const org=principal.organizationId;await member(tx,principal);await lockAttendanceChannel(tx,org,channel);const g=await control(tx,org,channel,jid(group));
      if(!g||!(await tx.query('SELECT 1 FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2 AND id=$3',[org,g.conversation_id,id])).rowCount)throw new GroupRuntimeError('GROUP_ATTEMPT_NOT_FOUND');
      return abandonQrDispatchAttempt(tx,{organizationId:org,actorId:principal.actorId,id,...input});
    });},
    async abandonObservation(principal:GroupPrincipal,channel:string,group:string,id:string,input:AbandonQrOutboundObservationRequest){return options.transact(principal.organizationId,async tx=>{
      const org=principal.organizationId;await member(tx,principal);await lockAttendanceChannel(tx,org,channel);const g=await control(tx,org,channel,jid(group));
      if(!g||!(await tx.query('SELECT 1 FROM qr_outbound_observations WHERE organization_id=$1 AND conversation_id=$2 AND id=$3',[org,g.conversation_id,id])).rowCount)throw new GroupRuntimeError('GROUP_OBSERVATION_NOT_FOUND');
      return abandonQrOutboundObservation(tx,{organizationId:org,actorId:principal.actorId,id,...input});
    });},
  };
}
