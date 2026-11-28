import {createHash,createHmac} from 'node:crypto';
import {z} from 'zod';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {ProviderContext} from '@jrc/providers';
import type {EngineSnapshot,FleetTransaction} from './runtime.js';

type Intent=Extract<NonNullable<ProviderContext['engineIntent']>,{kind:'QR_DISPATCH'}>;
export interface DispatchPeer {kind:'INDIVIDUAL'|'GROUP';value:string}
export function dispatchTraceOrganizations(value:string|undefined){
  return new Set(value?.trim()?z.array(z.uuid()).parse(value.split(',').map(entry=>entry.trim())):[]);
}
function fingerprint(value:string){return createHash('sha256').update(value).digest('hex');}
function engineScope(s:EngineSnapshot){return fingerprint(JSON.stringify([s.instanceId,s.engineId,s.generation,s.destinationFingerprint,s.traditional]));}
function proofPrefix(s:EngineSnapshot,p:DispatchPeer){
  return 'qr-receipt:v1:'+fingerprint(JSON.stringify([s.instanceId,s.engineId,s.generation,s.destinationFingerprint,
    s.traditional,p.kind,fingerprint(p.value)]))+':';
}
export async function recordPhysicalAcknowledgment(tx:TenantTransaction,snapshot:EngineSnapshot,channel:string,peer:DispatchPeer,
  ownerPhone:string,signingKey:string,key:string,state:'SENT'|'DELIVERED'|'READ'|'FAILED'){
  // Legacy webhook tokens bind tenant and channel only, even on a registered legacy engine.
  if(snapshot.engineId==='legacy'||snapshot.traditional||!['DELIVERED','READ'].includes(state))return;
  await tx.query('SET LOCAL synchronous_commit=on');
  const owner=createHmac('sha256',signingKey).update('qr-identity:v1:'+snapshot.organizationId+':'+channel+':'+snapshot.upstreamKey+':'+ownerPhone).digest('hex');
  const binding=createHmac('sha256',signingKey).update(JSON.stringify(['qr-engine:v1',snapshot.engineId,snapshot.generation,snapshot.destinationFingerprint,snapshot.traditional])).digest('hex');
  await tx.query(`WITH receipt AS (INSERT INTO messaging_status_events(organization_id,channel_id,provider_scope,upstream_message_id,state)
    SELECT q.organization_id,q.channel_id,$8::text||q.scope_id::text,$9,$10 FROM qr_identity_scopes q
    WHERE q.organization_id=$1 AND q.channel_id=$2 AND q.instance_id=$3 AND q.upstream_instance_key=$4
      AND q.owner_fingerprint=$5 AND q.binding_fingerprint=$6
      AND EXISTS(SELECT 1 FROM messaging_channels c WHERE c.organization_id=q.organization_id AND c.id=q.channel_id AND c.instance_id=$7)
    ON CONFLICT(organization_id,channel_id,provider_scope,upstream_message_id,state) DO NOTHING RETURNING provider_scope,state)
    UPDATE messaging_messages m SET state=r.state,updated_at=clock_timestamp() FROM receipt r,qr_traced_dispatch_attempts a
    WHERE m.organization_id=$1 AND m.channel_id=$2 AND m.direction='OUTGOING' AND m.upstream_message_id=$9
      AND a.organization_id=m.organization_id AND a.channel_id=m.channel_id AND a.conversation_id=m.conversation_id AND a.message_id=m.id
      AND a.state='CONFIRMED' AND a.provider_message_id=m.upstream_message_id AND a.physical_response_key=m.upstream_message_id
      AND a.physical_dispatch->>'receiptScope'=r.provider_scope
      AND NOT a.key_conflict
      AND (m.state='SENT' OR m.state='DELIVERED' AND r.state='READ')`,
    [snapshot.organizationId,channel,snapshot.instanceId,snapshot.upstreamKey,owner,binding,snapshot.instanceId,proofPrefix(snapshot,peer),key,state]);
}
// These columns record firsthand evidence independently of legacy fleet registration backfill.
export async function pinPhysicalDispatch(transact:FleetTransaction,snapshot:EngineSnapshot,intent:Intent,peer:DispatchPeer,signingKey?:string){
  const binding=signingKey?createHmac('sha256',signingKey).update(JSON.stringify(['qr-engine:v1',snapshot.engineId,snapshot.generation,snapshot.destinationFingerprint,snapshot.traditional])).digest('hex'):null;
  const row=await transact(snapshot.organizationId,async tx=>{
    await tx.query('SET LOCAL synchronous_commit=on');
    return tx.query(`INSERT INTO qr_dispatch_evidence(organization_id,attempt_id,engine_scope,physical_dispatch)
    SELECT a.organization_id,a.id,$14,jsonb_build_object(
    'version',1,'engineId',$4::text,'generation',$5::bigint,'destinationFingerprint',$6::text,'traditional',$7::boolean,
    'instanceId',ch.instance_id,'recipientKind',cv.recipient_kind,'peerHash',encode(sha256(convert_to($9,'UTF8')),'hex'),
    'identityScopeId',q.scope_id,'receiptScope',CASE WHEN $4<>'legacy' AND NOT $7 THEN $13::text||q.scope_id::text END,'authorizedAt',clock_timestamp())
    FROM qr_dispatch_attempts a, messaging_channels ch JOIN instances i ON i.organization_id=ch.organization_id AND i.id=ch.instance_id
    JOIN messaging_conversations cv ON cv.organization_id=ch.organization_id AND cv.channel_id=ch.id
    LEFT JOIN messaging_contacts contact ON contact.organization_id=cv.organization_id AND contact.id=cv.contact_id
    LEFT JOIN qr_identity_scopes q ON q.organization_id=ch.organization_id AND q.channel_id=ch.id AND q.instance_id=i.id
      AND q.upstream_instance_key=i.upstream_instance_key AND q.owner_fingerprint IS NOT NULL AND q.binding_fingerprint=$12
    JOIN messaging_messages m ON m.organization_id=cv.organization_id AND m.conversation_id=cv.id AND m.channel_id=ch.id
    WHERE a.organization_id=$1 AND a.message_id=$2 AND a.lease_token=$3 AND a.state='DISPATCHED' AND a.lease_expires_at>clock_timestamp()
      AND a.organization_id=ch.organization_id AND a.channel_id=ch.id AND a.conversation_id=cv.id
      AND ch.instance_id=$8 AND i.upstream_instance_key=$11 AND cv.recipient_kind=$10
      AND m.id=a.message_id AND m.direction='OUTGOING' AND m.state='SENDING'
      AND (CASE WHEN cv.recipient_kind='GROUP' THEN cv.group_jid ELSE contact.external_id END)=$9
      AND (a.engine_id IS NULL AND $7 OR
        (a.engine_id,a.engine_generation,a.engine_fingerprint,a.engine_instance_id)=($4,$5,$6,$8::uuid))
    FOR SHARE OF a,ch,i,m
    ON CONFLICT(organization_id,attempt_id) DO NOTHING RETURNING attempt_id`,[snapshot.organizationId,intent.messageId,intent.leaseToken,snapshot.engineId,snapshot.generation,
      snapshot.destinationFingerprint,snapshot.traditional,snapshot.instanceId,peer.value,peer.kind,snapshot.upstreamKey,binding,proofPrefix(snapshot,peer),engineScope(snapshot)]);
  });
  if(!row.rowCount)throw Object.assign(Error('QR_PHYSICAL_DISPATCH_UNPROVEN'),{uncertain:true,code:'QR_PHYSICAL_DISPATCH_UNPROVEN'});
}
export async function savePhysicalResponse(transact:FleetTransaction,snapshot:EngineSnapshot,intent:Intent,providerKey:unknown){
  if(typeof providerKey!=='string'||providerKey.length>256||!providerKey.trim())throw Error('QR_PHYSICAL_RESPONSE_UNPROVEN');
  const result=await transact(snapshot.organizationId,async tx=>{
    await tx.query('SET LOCAL synchronous_commit=on');
    const scope=engineScope(snapshot);
    // Use one lock order for competing recipients of the same provider key.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 97))',[scope+':'+providerKey]);
    const proof=(await tx.query<{attempt_id:string;physical_response_key:string|null;key_conflict:boolean}>(`SELECT e.attempt_id,e.physical_response_key,e.key_conflict
      FROM qr_dispatch_evidence e JOIN qr_dispatch_attempts a ON a.organization_id=e.organization_id AND a.id=e.attempt_id
      WHERE e.organization_id=$1 AND e.engine_scope=$2 AND a.message_id=$3 AND a.lease_token=$4 FOR UPDATE OF e`,
      [snapshot.organizationId,scope,intent.messageId,intent.leaseToken])).rows[0];
    if(!proof)return false;
    const other=(await tx.query<{attempt_id:string}>(`SELECT attempt_id FROM qr_dispatch_evidence
      WHERE organization_id=$1 AND engine_scope=$2 AND physical_response_key=$3 AND attempt_id<>$4 FOR UPDATE`,
      [snapshot.organizationId,scope,providerKey,proof.attempt_id])).rows[0];
    if(other||proof.key_conflict||proof.physical_response_key&&proof.physical_response_key!==providerKey){
      await tx.query(`UPDATE qr_dispatch_evidence SET key_conflict=true, conflicting_response_key=CASE
        WHEN attempt_id=$2 THEN coalesce(conflicting_response_key,$3) ELSE conflicting_response_key END
        WHERE organization_id=$1 AND attempt_id=ANY($4::uuid[])`,
        [snapshot.organizationId,proof.attempt_id,providerKey,[proof.attempt_id,...(other?[other.attempt_id]:[])]]);
      return false;
    }
    await tx.query('UPDATE qr_dispatch_evidence SET physical_response_key=$3 WHERE organization_id=$1 AND attempt_id=$2',
      [snapshot.organizationId,proof.attempt_id,providerKey]);
    return true;
  });
  if(!result)throw Error('QR_PHYSICAL_RESPONSE_UNPROVEN');
}

// The normal projection continues to handle pre-trace and legacy callbacks. A generation-bound
// original uses only the authenticated, peer-bound receipt namespace captured at dispatch.
export function ordinaryQrReceipt(messageAlias:string){
  return `NOT EXISTS(SELECT 1 FROM qr_traced_dispatch_attempts trace WHERE trace.organization_id=${messageAlias}.organization_id
    AND trace.message_id=${messageAlias}.id AND (trace.physical_dispatch->>'receiptScope' IS NOT NULL OR trace.key_conflict)
    AND trace.state='CONFIRMED')`;
}
