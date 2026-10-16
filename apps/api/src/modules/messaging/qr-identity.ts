import {createHash,createHmac} from 'node:crypto';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {QrContactEvent,QrEvent,QrUnresolvedContactEvent} from './qr-events.js';

interface Scope {scope_id:string;owner_fingerprint:string|null;instance_id:string;upstream_instance_key:string;binding_fingerprint:string}
interface IdentityContext {organizationId:string;channelId:string;instanceId:string;instanceKey:string;signingKey:string;bindingFingerprint:string}
const contactKinds=new Set(['message','outbound','media','outbound-media']);

/** Caller holds the channel lock. An owner change invalidates aliases, never reassigns them. */
export async function observeQrIdentityScope(tx:TenantTransaction,input:IdentityContext,ownerPhone:string|undefined,allowOwnerChange:boolean){
  const fingerprint=ownerPhone?createHmac('sha256',input.signingKey).update(`qr-identity:v1:${input.organizationId}:${input.channelId}:${input.instanceKey}:${ownerPhone}`).digest('hex'):null;
  await tx.query(`INSERT INTO qr_identity_scopes(organization_id,channel_id,instance_id,upstream_instance_key,owner_fingerprint,binding_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,channel_id) DO NOTHING`,
  [input.organizationId,input.channelId,input.instanceId,input.instanceKey,fingerprint,input.bindingFingerprint]);
  let current=(await tx.query<Scope>('SELECT * FROM qr_identity_scopes WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE',[input.organizationId,input.channelId])).rows[0]!;
  const changed=current.instance_id!==input.instanceId||current.upstream_instance_key!==input.instanceKey||current.owner_fingerprint!==fingerprint||current.binding_fingerprint!==input.bindingFingerprint;
  if(changed){
    // A different sender without a connection observation invalidates the old
    // scope immediately, but cannot carry its old aliases into the new owner.
    const nextFingerprint=allowOwnerChange||current.owner_fingerprint===null?fingerprint:null;
    await tx.query(`UPDATE qr_identity_pending_events SET status='STALE',reason='QR_IDENTITY_CHANGED',updated_at=now()
      WHERE organization_id=$1 AND channel_id=$2 AND status='WAITING' AND scope_id IS NOT NULL`,[input.organizationId,input.channelId]);
    current=(await tx.query<Scope>(`UPDATE qr_identity_scopes SET instance_id=$3,upstream_instance_key=$4,owner_fingerprint=$5,binding_fingerprint=$6,scope_id=gen_random_uuid(),updated_at=now()
      WHERE organization_id=$1 AND channel_id=$2 RETURNING *`,[input.organizationId,input.channelId,input.instanceId,input.instanceKey,nextFingerprint,input.bindingFingerprint])).rows[0]!;
  }
  return fingerprint&&current.owner_fingerprint===fingerprint&&current.instance_id===input.instanceId&&current.upstream_instance_key===input.instanceKey?current.scope_id:null;
}

async function preserve(tx:TenantTransaction,input:IdentityContext,scope:string|null,lid:string,event:QrUnresolvedContactEvent,status:'WAITING'|'CONFLICT'){
  const {lid:_lid,recoveredIdentity:_recovered,...content}=event;
  const {historical:_historical,...hashContent}=content;
  const body=JSON.stringify(content),hash=createHash('sha256').update(JSON.stringify(hashContent)).digest('hex');
  const exists=(await tx.query(`SELECT 1 FROM qr_identity_pending_events WHERE organization_id=$1 AND channel_id=$2 AND provider_message_id=$3`,[input.organizationId,input.channelId,event.upstreamMessageId])).rowCount;
  if(!exists&&(await tx.query<{n:number}>(`SELECT count(*)::int AS n FROM qr_identity_pending_events WHERE organization_id=$1 AND channel_id=$2 AND status IN ('WAITING','CONFLICT','STALE')`,[input.organizationId,input.channelId])).rows[0]!.n>=10000)
    throw Object.assign(new Error('QR_IDENTITY_BACKLOG_FULL'),{code:'QR_IDENTITY_BACKLOG_FULL',status:503});
  await tx.query(`INSERT INTO qr_identity_pending_events(organization_id,channel_id,scope_id,lid,provider_message_id,event,body_hash,occurred_at,status,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(organization_id,channel_id,provider_message_id) DO UPDATE
    SET status=CASE WHEN qr_identity_pending_events.body_hash<>EXCLUDED.body_hash OR qr_identity_pending_events.lid<>EXCLUDED.lid THEN 'CONFLICT' ELSE qr_identity_pending_events.status END,
      reason=CASE WHEN qr_identity_pending_events.body_hash<>EXCLUDED.body_hash OR qr_identity_pending_events.lid<>EXCLUDED.lid THEN 'QR_IDENTITY_EVENT_CONFLICT' ELSE qr_identity_pending_events.reason END,
      updated_at=now()`,[input.organizationId,input.channelId,scope,lid,event.upstreamMessageId,body,hash,event.occurredAt,status,
      status==='CONFLICT'?'QR_LID_MAPPING_CONFLICT':scope?'LID_NUMBER_UNRESOLVED':'QR_OWNER_UNVERIFIED']);
}

/** Persist only validated message fields, never raw webhook envelopes or engine credentials. */
export async function resolveQrIdentityEvents(tx:TenantTransaction,input:IdentityContext,events:QrEvent[],ownerPhone:string|undefined):Promise<QrEvent[]>{
  const relevant=events.some(event=>event.kind==='identity-pending'||'lid' in event&&event.lid);
  if(!relevant){
    if(ownerPhone&&events.some(event=>contactKinds.has(event.kind))&&(await tx.query('SELECT 1 FROM qr_identity_scopes WHERE organization_id=$1 AND channel_id=$2',[input.organizationId,input.channelId])).rowCount)
      await observeQrIdentityScope(tx,input,ownerPhone,false);
    return events;
  }
  const scope=ownerPhone?await observeQrIdentityScope(tx,input,ownerPhone,false):null;
  const ready:QrEvent[]=[];
  // Learn the entire authenticated batch before resolving any message. Two
  // contradictory pairs in one batch must quarantine both, including the first.
  for(const event of events){
    if(contactKinds.has(event.kind)&&'lid' in event&&event.lid&&scope&&!(event as QrContactEvent).historical){
      const contact=event as QrContactEvent;
      const alias=(await tx.query<{status:string}>(`INSERT INTO qr_contact_aliases(organization_id,channel_id,scope_id,lid,phone)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,channel_id,scope_id,lid) DO UPDATE
        SET status=CASE WHEN qr_contact_aliases.phone<>EXCLUDED.phone THEN 'CONFLICT' ELSE qr_contact_aliases.status END,updated_at=now() RETURNING status`,
      [input.organizationId,input.channelId,scope,contact.lid,contact.externalId])).rows[0]!;
      if(alias.status==='CONFLICT'){
        await tx.query(`UPDATE qr_identity_pending_events SET status='CONFLICT',reason='QR_LID_MAPPING_CONFLICT',updated_at=now()
          WHERE organization_id=$1 AND channel_id=$2 AND scope_id=$3 AND lid=$4 AND status='WAITING'`,[input.organizationId,input.channelId,scope,contact.lid]);
      }
    }
  }
  const aliases=new Map(scope?(await tx.query<{lid:string;phone:string;status:string}>(`SELECT lid,phone,status FROM qr_contact_aliases
    WHERE organization_id=$1 AND channel_id=$2 AND scope_id=$3 AND lid=ANY($4::text[])`,[input.organizationId,input.channelId,scope,
      events.flatMap(event=>event.kind==='identity-pending'?[event.lid]:'lid' in event&&event.lid?[event.lid]:[])])).rows.map(row=>[row.lid,row] as const):[]);
  for(const event of events){
    if(event.kind==='identity-pending'||contactKinds.has(event.kind)&&'lid' in event&&event.lid&&scope&&!(event as QrContactEvent).historical){
      const lid=event.kind==='identity-pending'?event.lid:(event as QrContactEvent).lid!;
      const pending=event.kind==='identity-pending'?event.event:((({externalId:_phone,...rest})=>rest)(event as QrContactEvent));
      const existing=(await tx.query('SELECT 1 FROM qr_identity_pending_events WHERE organization_id=$1 AND channel_id=$2 AND provider_message_id=$3',[input.organizationId,input.channelId,pending.upstreamMessageId])).rowCount;
      const alias=aliases.get(lid);
      if(alias?.status==='CONFIRMED'&&!existing){
        ready.push({...pending,externalId:alias.phone,lid} as QrContactEvent);continue;
      }
      await preserve(tx,input,scope,lid,pending,alias?.status==='CONFLICT'?'CONFLICT':'WAITING');continue;
    }
    ready.push(event);
  }
  return [...(scope?await recoverQrIdentityEvents(tx,input):[]),...ready];
}

/** At most 100 recovered facts per turn; the same transaction also persists their messages. */
export async function recoverQrIdentityEvents(tx:TenantTransaction,input:Pick<IdentityContext,'organizationId'|'channelId'|'bindingFingerprint'>):Promise<QrContactEvent[]>{
  const rows=(await tx.query<{provider_message_id:string;event:QrUnresolvedContactEvent;phone:string}>(`SELECT p.provider_message_id,p.event,a.phone
    FROM qr_identity_pending_events p JOIN qr_identity_scopes s ON s.organization_id=p.organization_id AND s.channel_id=p.channel_id AND s.scope_id=p.scope_id
    JOIN messaging_channels c ON c.organization_id=s.organization_id AND c.id=s.channel_id AND c.instance_id=s.instance_id
    JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id AND i.upstream_instance_key=s.upstream_instance_key
    JOIN qr_contact_aliases a ON a.organization_id=p.organization_id AND a.channel_id=p.channel_id AND a.scope_id=p.scope_id AND a.lid=p.lid
    WHERE p.organization_id=$1 AND p.channel_id=$2 AND p.status='WAITING' AND a.status='CONFIRMED'
      AND s.owner_fingerprint IS NOT NULL AND s.binding_fingerprint=$3 AND c.deleting_at IS NULL AND i.archived_at IS NULL AND i.status='CONNECTED'
    ORDER BY p.occurred_at,p.provider_message_id LIMIT 100 FOR UPDATE OF p`,[input.organizationId,input.channelId,input.bindingFingerprint])).rows;
  for(const row of rows)await tx.query(`UPDATE qr_identity_pending_events SET status='RESOLVED',reason='LID_NUMBER_RESOLVED',event=NULL,updated_at=now()
    WHERE organization_id=$1 AND channel_id=$2 AND provider_message_id=$3`,[input.organizationId,input.channelId,row.provider_message_id]);
  return rows.map(row=>({...row.event,externalId:row.phone,occurredAt:new Date(row.event.occurredAt),recoveredIdentity:true}) as QrContactEvent);
}
