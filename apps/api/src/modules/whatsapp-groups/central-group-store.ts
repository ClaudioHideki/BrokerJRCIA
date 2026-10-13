import {groupCentralEnvelope,type GroupCentralScope} from './group-central-identity.js';

export function groupScopeUnchanged(expected:GroupCentralScope,current:GroupCentralScope){
 return groupCentralEnvelope(expected,'scope').scopeKey===groupCentralEnvelope(current,'scope').scopeKey;
}
export function groupMessageBelongsToScope(scope:GroupCentralScope,providerScope:string){
 groupCentralEnvelope(scope,'scope');
 return providerScope===`g3:${scope.groupJid}:${scope.identityRevision}`;
}
/** The caller obtains this evidence from the persisted observation and current
 * control. A webhook body or browser field cannot stand in for this evidence. */
export function groupReplyMayDispatch(evidence:{scopeKey:string;currentScopeKey:string;kind:string;disposition:string;conversationMode:string;attendanceRevision:number;currentAttendanceRevision:number}){
 return /^[a-f0-9]{64}$/u.test(evidence.scopeKey)&&evidence.scopeKey===evidence.currentScopeKey
  &&evidence.kind==='HUMAN_PUBLIC'&&evidence.disposition==='APPLIED'&&evidence.conversationMode==='HUMAN'
  &&Number.isSafeInteger(evidence.attendanceRevision)&&evidence.attendanceRevision>=0
  &&evidence.attendanceRevision===evidence.currentAttendanceRevision;
}

export interface GroupCentralSnapshot{
 scope:GroupCentralScope;conversationId:string;subject:string;accountId:number;inboxId:number;
 credentialRevision:number;catalogSnapshotId:string;webhookBinding:string;
 envelope:ReturnType<typeof groupCentralEnvelope>;
}
export interface GroupCentralQuery{query(sql:string,values:unknown[]):Promise<{rows:any[];rowCount:number|null}>}
/** Runs within the caller's tenant transaction and channel lock. The expected
 * webhook binding is derived by the runtime from private server configuration. */
export async function readGroupCentralSnapshot(tx:GroupCentralQuery,input:{organizationId:string;channelId:string;conversationId:string;expectedWebhookBinding:string|null;providerScope?:string}):Promise<GroupCentralSnapshot|null>{
 if(!input.expectedWebhookBinding)return null;
 const row=(await tx.query(`/* GROUP_CENTRAL_CURRENT_SCOPE */
  SELECT c.organization_id,c.id AS channel_id,c.instance_id,m.id AS conversation_id,m.group_jid,item.subject,
   x.id AS integration_id,x.inbox_id,a.account_id,a.credential_version,d.revision AS destination_revision,
   k.identity_revision,k.identity_fingerprint,k.snapshot_id,k.valid_until,w.binding_fingerprint
  FROM messaging_channels c JOIN organizations org ON org.id=c.organization_id
  JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
  JOIN messaging_conversations m ON m.organization_id=c.organization_id AND m.channel_id=c.id
  JOIN whatsapp_group_catalogs k ON k.organization_id=c.organization_id AND k.channel_id=c.id
  JOIN whatsapp_group_catalog_items item ON item.organization_id=k.organization_id AND item.channel_id=k.channel_id AND item.group_jid=m.group_jid
  JOIN whatsapp_group_participation p ON p.organization_id=k.organization_id AND p.channel_id=k.channel_id AND p.group_jid=m.group_jid AND p.identity_revision=k.identity_revision
  JOIN chatwoot_connections x ON x.organization_id=c.organization_id AND x.channel_id=c.id
  JOIN chatwoot_accounts a ON a.organization_id=x.organization_id
  JOIN chatwoot_destinations d ON d.organization_id=a.organization_id AND d.base_url=a.base_url
  JOIN LATERAL(SELECT * FROM whatsapp_group_webhook_operations o WHERE o.organization_id=c.organization_id AND o.channel_id=c.id
   ORDER BY (o.phase IN('PREPARED','DISPATCHED','UNKNOWN')) DESC,o.created_at DESC,o.id DESC LIMIT 1)w ON true
  WHERE c.organization_id=$1 AND c.id=$2 AND m.id=$3 AND org.status='ACTIVE'
   AND m.recipient_kind='GROUP' AND m.contact_id IS NULL AND c.provider='BAILEYS' AND c.transport='BROKER_TRANSPORT'
   AND c.deleting_at IS NULL AND i.archived_at IS NULL AND i.status='CONNECTED'
   AND item.selected AND k.last_error_code IS NULL AND k.valid_until>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM whatsapp_group_events e WHERE e.organization_id=c.organization_id AND e.channel_id=c.id AND e.group_jid=m.group_jid
     AND e.identity_revision=k.identity_revision AND e.identity_fingerprint=k.identity_fingerprint AND e.received_at>k.observed_at)
   AND p.own_state='PRESENT_FROM_CATALOG' AND p.identity_fingerprint=k.identity_fingerprint AND p.source_snapshot_id=k.snapshot_id
   AND x.status='READY' AND a.status='READY' AND d.approval_status='APPROVED' AND x.inbox_id IS NOT NULL AND a.account_id IS NOT NULL
   AND chatwoot_channel_identity_ready(c.organization_id,c.id)
   AND w.phase='CONFIRMED' AND w.instance_id=i.id AND w.identity_revision=k.identity_revision AND w.identity_fingerprint=k.identity_fingerprint AND w.binding_fingerprint=$4
  FOR SHARE OF c,i,m,k,item,p,x,a,d`,[input.organizationId,input.channelId,input.conversationId,input.expectedWebhookBinding])).rows[0];
 if(!row)return null;
 // Check time again after row locks: a catalog can expire while this statement waits.
 if(!(await tx.query('SELECT clock_timestamp()<$1::timestamptz AS current',[row.valid_until])).rows[0]?.current)return null;
 const scope:GroupCentralScope={organizationId:row.organization_id,channelId:row.channel_id,integrationId:row.integration_id,destinationRevision:Number(row.destination_revision),instanceId:row.instance_id,
  identityRevision:Number(row.identity_revision),identityFingerprint:row.identity_fingerprint,groupJid:row.group_jid};
 if(input.providerScope!==undefined&&!groupMessageBelongsToScope(scope,input.providerScope))return null;
 const accountId=Number(row.account_id),inboxId=Number(row.inbox_id),credentialRevision=Number(row.credential_version);
 if(![accountId,inboxId,credentialRevision].every(n=>Number.isSafeInteger(n)&&n>0))return null;
 return{scope,conversationId:row.conversation_id,subject:row.subject,accountId,inboxId,credentialRevision,catalogSnapshotId:row.snapshot_id,webhookBinding:row.binding_fingerprint,envelope:groupCentralEnvelope(scope,row.subject)};
}

export interface GroupRemoteMap{contact_id:string;source_id:string;remote_conversation_id:string}
export async function readGroupRemoteMap(tx:GroupCentralQuery,current:GroupCentralSnapshot):Promise<GroupRemoteMap|null>{
 const s=current.scope;
 return (await tx.query(`SELECT g.remote_contact_id AS contact_id,g.source_id,g.remote_conversation_id
  FROM chatwoot_group_scopes g JOIN chatwoot_conversations c ON c.organization_id=g.organization_id AND c.integration_id=g.integration_id
   AND c.conversation_id=g.conversation_id AND c.remote_conversation_id=g.remote_conversation_id AND c.contact_id=g.remote_contact_id AND c.source_id=g.source_id
  WHERE g.organization_id=$1 AND g.scope_key=$2 AND g.channel_id=$3 AND g.conversation_id=$4 AND g.integration_id=$5
   AND g.destination_revision=$6 AND g.remote_account_id=$7 AND g.remote_inbox_id=$8 AND g.retired_at IS NULL`,
 [s.organizationId,current.envelope.scopeKey,s.channelId,current.conversationId,s.integrationId,s.destinationRevision,current.accountId,current.inboxId])).rows[0]??null;
}

/** All current-scope reads and this write share the channel transaction lock.
 * Returned remote facts must already have passed canonical Account/Inbox GET. */
export async function saveGroupRemoteMap(tx:GroupCentralQuery,current:GroupCentralSnapshot,remote:{contactId:number;sourceId:string;conversationId:number}){
 if(![remote.contactId,remote.conversationId].every(n=>Number.isSafeInteger(n)&&n>0)||remote.sourceId!==current.envelope.sourceId)throw Error('GROUP_CENTRAL_RESPONSE_INVALID');
 const s=current.scope,key=current.envelope.scopeKey;
 const existing=await readGroupRemoteMap(tx,current);
 if(existing){if(Number(existing.contact_id)!==remote.contactId||Number(existing.remote_conversation_id)!==remote.conversationId||existing.source_id!==remote.sourceId)throw Error('GROUP_CENTRAL_MAPPING_CONFLICT');return;}
 const previous=(await tx.query(`SELECT scope_key FROM chatwoot_group_scopes WHERE organization_id=$1 AND integration_id=$2 AND conversation_id=$3 AND retired_at IS NULL FOR UPDATE`,[s.organizationId,s.integrationId,current.conversationId])).rows[0];
 if(previous){
  if((await tx.query(`SELECT 1 FROM chatwoot_mirror_attempts WHERE organization_id=$1 AND conversation_id=$2 AND state IN('DISPATCHED','UNKNOWN')
    UNION ALL SELECT 1 FROM qr_dispatch_attempts WHERE organization_id=$1 AND conversation_id=$2 AND state IN('DISPATCHED','UNKNOWN')`,[s.organizationId,current.conversationId])).rowCount)throw Error('GROUP_CENTRAL_OUTCOME_UNKNOWN');
  await tx.query('UPDATE chatwoot_group_scopes SET retired_at=clock_timestamp() WHERE organization_id=$1 AND scope_key=$2 AND retired_at IS NULL',[s.organizationId,previous.scope_key]);
 }
 await tx.query(`INSERT INTO chatwoot_group_scopes(organization_id,scope_key,channel_id,conversation_id,integration_id,destination_revision,instance_id,identity_revision,identity_fingerprint,group_jid,remote_account_id,remote_inbox_id,remote_contact_id,remote_conversation_id,source_id)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[s.organizationId,key,s.channelId,current.conversationId,s.integrationId,s.destinationRevision,s.instanceId,s.identityRevision,s.identityFingerprint,s.groupJid,current.accountId,current.inboxId,remote.contactId,remote.conversationId,remote.sourceId]);
 await tx.query(`INSERT INTO chatwoot_conversations(organization_id,integration_id,conversation_id,contact_id,source_id,remote_conversation_id) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(organization_id,integration_id,conversation_id) DO UPDATE SET contact_id=EXCLUDED.contact_id,source_id=EXCLUDED.source_id,remote_conversation_id=EXCLUDED.remote_conversation_id`,[s.organizationId,s.integrationId,current.conversationId,remote.contactId,remote.sourceId,remote.conversationId]);
 if(previous)await tx.query(`UPDATE chatwoot_attendance_controls SET integration_id=$3,destination_revision=$4,account_id=$5,inbox_id=$6,remote_conversation_id=$7,
  state=CASE WHEN state IN('HUMAN','PAUSED','RECONCILE') THEN state ELSE 'INITIALIZING' END,observed_remote_updated_at=NULL,last_observation_id=NULL,cycle=cycle+1,revision=revision+1,updated_at=clock_timestamp()
  WHERE organization_id=$1 AND conversation_id=$2`,[s.organizationId,current.conversationId,s.integrationId,s.destinationRevision,current.accountId,current.inboxId,remote.conversationId]);
}
