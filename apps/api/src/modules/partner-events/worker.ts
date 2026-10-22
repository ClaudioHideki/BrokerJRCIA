import { createHmac,randomUUID } from 'node:crypto';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { createChatwootSafeFetch } from '../integrations/chatwoot-safe-http.js';
import { normalizeChatwootOrigin } from '../integrations/chatwoot-destination.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';

export function normalizeWebhookUrl(value: string): string {
 const url = new URL(value);
 normalizeChatwootOrigin(url.origin);
 if (value.length > 2048 || url.username || url.password || url.search || url.hash || /[\\\s]/u.test(value)) throw new Error('INVALID_WEBHOOK_URL');
 return url.href;
}
export function signPartnerEvent(secret: string, eventId: string, timestamp: string, body: string): string {
 return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${eventId}.${body}`).digest('hex');
}
export const retryDelayMs = (attempt: number) => Math.min(300_000, 1000 * 2 ** Math.max(0, attempt - 1));
export interface DeliveryClaim {
 deliveryId: string; endpointId: string; eventId: string; organizationId: string; url: string;
 encryptedSecret: string; attempts: number; envelope: Record<string, unknown>;
 leaseToken?:string;
}
export interface DeliverySettlement {status:'DELIVERED'|'PENDING'|'FAILED';attempts:number;errorCode:string|null;delayMs:number}
export async function claimDelivery(tx: TenantTransaction, org: string): Promise<DeliveryClaim | null> {
 await requireActiveOrganization(tx, org);
 await tx.query('SELECT partner_publish_events()');
 await tx.query(`UPDATE partner_event_deliveries SET status='FAILED',lease_token=NULL,lease_expires_at=NULL,last_error_code='DELIVERY_ATTEMPTS_EXHAUSTED',updated_at=now()
 WHERE organization_id=$1 AND status='RUNNING' AND lease_expires_at<=now() AND attempts>=10`,[org]);
 const claim=(await tx.query<DeliveryClaim>(`SELECT d.id AS "deliveryId",p.id AS "endpointId",e.id AS "eventId",d.organization_id AS "organizationId",
 p.url,p.encrypted_secret AS "encryptedSecret",d.attempts,
 jsonb_build_object('schemaVersion',1,'eventId',e.id,'cursor',e.sequence_number::text,'organizationId',e.organization_id,
 'type',e.event_type,'occurredAt',e.occurred_at,'data',e.payload) AS envelope
 FROM partner_event_deliveries d JOIN partner_webhook_endpoints p ON p.organization_id=d.organization_id AND p.id=d.endpoint_id
 JOIN partner_events e ON e.organization_id=d.organization_id AND e.id=d.event_id
 WHERE d.organization_id=$1 AND e.sequence_number IS NOT NULL AND d.attempts<10 AND ((d.status='PENDING' AND d.available_at<=now()) OR (d.status='RUNNING' AND d.lease_expires_at<=now())) AND p.status='ACTIVE'
 ORDER BY d.available_at,d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [org])).rows[0];
 if(!claim)return null;
 const leaseToken=randomUUID();
 await tx.query(`UPDATE partner_event_deliveries SET status='RUNNING',attempts=attempts+1,lease_token=$3,lease_expires_at=now()+interval '30 seconds',updated_at=now() WHERE organization_id=$1 AND id=$2`,[org,claim.deliveryId,leaseToken]);
 return {...claim,leaseToken};
}
export async function authorizeDelivery(tx:TenantTransaction,claim:DeliveryClaim):Promise<boolean>{
 await requireActiveOrganization(tx,claim.organizationId);
 return Boolean((await tx.query(`SELECT 1 FROM partner_event_deliveries d JOIN partner_webhook_endpoints p ON p.organization_id=d.organization_id AND p.id=d.endpoint_id WHERE d.organization_id=$1 AND d.id=$2 AND d.lease_token=$3 AND d.status='RUNNING' AND d.lease_expires_at>now() AND p.status='ACTIVE' AND p.encrypted_secret=$4`,[claim.organizationId,claim.deliveryId,claim.leaseToken,claim.encryptedSecret])).rowCount);
}
export async function settleDelivery(tx: TenantTransaction, claim: DeliveryClaim, result: DeliverySettlement): Promise<void> {
 await tx.query(`UPDATE partner_event_deliveries SET status=$4,attempts=$5,last_error_code=$6,
 available_at=now()+($7::double precision*interval '1 millisecond'),updated_at=now(),lease_token=NULL,lease_expires_at=NULL
 WHERE organization_id=$1 AND id=$2 AND endpoint_id=$3 AND status='RUNNING' AND lease_token=$8 AND lease_expires_at>now()`,
 [claim.organizationId,claim.deliveryId,claim.endpointId,result.status,result.attempts,result.errorCode,result.delayMs,claim.leaseToken]);
}
export function createPartnerEventWorker(options: {
 transact<T>(org:string,operation:OrganizationTransaction<T>):Promise<T>;
 openSecret(claim:DeliveryClaim):string;
 claim?:typeof claimDelivery;authorize?:typeof authorizeDelivery;settle?:typeof settleDelivery;send?:typeof globalThis.fetch;now?:()=>Date;
}) {
 return { processOne: async(org:string) => {
  const claim=await options.transact(org,tx=>(options.claim??claimDelivery)(tx,org));if(!claim)return false;
  if(!await options.transact(org,tx=>(options.authorize??authorizeDelivery)(tx,claim)))return true;
  const attempt=claim.attempts+1;let errorCode:string|null=null;let delivered=false;let permanent=false;
  try {
   const url=normalizeWebhookUrl(claim.url),body=JSON.stringify(claim.envelope);
   if(Buffer.byteLength(body)>2*1024*1024){permanent=true;throw new Error('PAYLOAD_LIMIT');}
   const timestamp=String(Math.floor((options.now?.()??new Date()).getTime()/1000));
   const headers={'content-type':'application/json','x-jrc-event-id':claim.eventId,'x-jrc-timestamp':timestamp,
    'x-jrc-signature':signPartnerEvent(options.openSecret(claim),claim.eventId,timestamp,body)};
   const send=options.send??createChatwootSafeFetch({origin:new URL(url).origin,timeoutMs:10000,maxResponseBytes:65536});
   const response=await send(url,{method:'POST',headers,body,redirect:'manual',signal:AbortSignal.timeout(10000)});
   delivered=response.status>=200&&response.status<300;
   if(!delivered){errorCode=`HTTP_${response.status}`;permanent=response.status<500&&![408,425,429].includes(response.status);}
   await response.body?.cancel();
  }catch{errorCode??=permanent?'PAYLOAD_LIMIT':'DELIVERY_UNAVAILABLE';}
  await options.transact(org,tx=>(options.settle??settleDelivery)(tx,claim,{status:delivered?'DELIVERED':permanent||attempt>=10?'FAILED':'PENDING',attempts:attempt,errorCode,delayMs:delivered?0:retryDelayMs(attempt)}));
  return true;
 } };
}
