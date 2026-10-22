import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import type { createIntegrationSecrets } from '../integrations/secrets.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { normalizeWebhookUrl } from './worker.js';

export class PartnerEventError extends Error {constructor(readonly code:string,readonly statusCode:number,readonly cursorInfo?:{retentionDays:30;earliestCursor:string|null;lastPrunedCursor:string;resetCursor:'0'}){super(code);}}
export interface PartnerEndpoint {id:string;url:string;status:'ACTIVE'|'REVOKED';createdAt:Date;revokedAt:Date|null}
export interface PartnerEvent {eventId:string;cursor:string;organizationId:string;type:string;occurredAt:Date;data:Record<string,unknown>}
const endpointColumns=`id,url,status,created_at AS "createdAt",revoked_at AS "revokedAt"`;
const endpointView=(row:PartnerEndpoint)=>({...row,createdAt:row.createdAt.toISOString(),revokedAt:row.revokedAt?.toISOString()??null});
export function createPartnerEventService(options:{transact<T>(org:string,operation:OrganizationTransaction<T>):Promise<T>;secrets:ReturnType<typeof createIntegrationSecrets>}){
 return {
  list:(org:string)=>options.transact(org,async tx=>{await requireActiveOrganization(tx,org);return {data:(await tx.query<PartnerEndpoint>(`SELECT ${endpointColumns} FROM partner_webhook_endpoints WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`,[org])).rows.map(endpointView)};}),
  create:async(org:string,input:{url:string},idempotencyKey:string)=>{
   let url:string;try{url=normalizeWebhookUrl(input.url);}catch{throw new PartnerEventError('INVALID_WEBHOOK_URL',422);}
   return options.transact(org,async tx=>{
    await requireActiveOrganization(tx,org);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('partner-events:'||$1,0))",[org]);
    if(!idempotencyKey||idempotencyKey.length>255)throw new PartnerEventError('INVALID_IDEMPOTENCY_KEY',422);
    const keyHash=createHash('sha256').update(idempotencyKey).digest('hex');
    const existing=(await tx.query<PartnerEndpoint&{encryptedSecret:string|null}>(`SELECT ${endpointColumns},encrypted_secret AS "encryptedSecret" FROM partner_webhook_endpoints WHERE organization_id=$1 AND idempotency_key=$2`,[org,keyHash])).rows[0];
    if(existing){
     if(existing.url!==url)throw new PartnerEventError('WEBHOOK_IDEMPOTENCY_CONFLICT',409);
     if(existing.status!=='ACTIVE'||!existing.encryptedSecret)throw new PartnerEventError('WEBHOOK_REVOKED',409);
     const {encryptedSecret,...endpoint}=existing;
     return {endpoint:endpointView(endpoint),signingSecret:options.secrets.decrypt(`partner-webhook:${org}:${endpoint.id}`,encryptedSecret),replayed:true};
    }
    const count=(await tx.query<{count:number}>(`SELECT count(*)::int AS count FROM partner_webhook_endpoints WHERE organization_id=$1 AND status='ACTIVE'`,[org])).rows[0]!.count;
    if(count>=5)throw new PartnerEventError('WEBHOOK_ENDPOINT_LIMIT',409);
    const id=randomUUID(),signingSecret=randomBytes(32).toString('base64url');
    const encrypted=options.secrets.encrypt(`partner-webhook:${org}:${id}`,signingSecret);
    const endpoint=(await tx.query<PartnerEndpoint>(`INSERT INTO partner_webhook_endpoints(organization_id,id,url,encrypted_secret,idempotency_key) VALUES($1,$2,$3,$4,$5) RETURNING ${endpointColumns}`,[org,id,url,encrypted,keyHash])).rows[0]!;
    return {endpoint:endpointView(endpoint),signingSecret,replayed:false};
   });
  },
  revoke:(org:string,id:string)=>options.transact(org,async tx=>{
   await requireActiveOrganization(tx,org);
   const endpoint=(await tx.query<PartnerEndpoint>(`UPDATE partner_webhook_endpoints SET status='REVOKED',encrypted_secret=NULL,revoked_at=COALESCE(revoked_at,now()) WHERE organization_id=$1 AND id=$2 RETURNING ${endpointColumns}`,[org,id])).rows[0];
   if(!endpoint)throw new PartnerEventError('WEBHOOK_NOT_FOUND',404);
   await tx.query(`UPDATE partner_event_deliveries SET status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE organization_id=$1 AND endpoint_id=$2 AND status IN ('PENDING','RUNNING')`,[org,id]);
   return endpointView(endpoint);
  }),
  events:(org:string,input:{after?:string|undefined;limit:number})=>options.transact(org,async tx=>{
   await requireActiveOrganization(tx,org);
   await tx.query('SELECT partner_publish_events()');
   const earliestCursor=(await tx.query<{earliestCursor:string|null}>(`SELECT min(sequence_number)::text AS "earliestCursor" FROM partner_events WHERE organization_id=$1 AND occurred_at>=now()-interval '30 days'`,[org])).rows[0]?.earliestCursor??null;
   const lastPrunedCursor=(await tx.query<{lastPrunedCursor:string}>(`SELECT last_pruned_cursor::text AS "lastPrunedCursor" FROM partner_event_cursor_state WHERE organization_id=$1`,[org])).rows[0]?.lastPrunedCursor??'0';
   if(input.after&&input.after!=='0'&&BigInt(input.after)<BigInt(lastPrunedCursor))throw new PartnerEventError('EVENT_CURSOR_EXPIRED',409,{retentionDays:30,earliestCursor,lastPrunedCursor,resetCursor:'0'});
   const rows=(await tx.query<PartnerEvent>(`SELECT id AS "eventId",sequence_number::text AS cursor,organization_id AS "organizationId",event_type AS type,occurred_at AS "occurredAt",payload AS data FROM partner_events WHERE organization_id=$1 AND sequence_number>$2::bigint AND occurred_at>=now()-interval '30 days' ORDER BY sequence_number LIMIT $3`,[org,input.after??'0',input.limit])).rows;
   return {schemaVersion:1 as const,retentionDays:30 as const,earliestCursor,lastPrunedCursor,data:rows.map(row=>({schemaVersion:1 as const,...row,occurredAt:row.occurredAt.toISOString()})),nextCursor:rows.at(-1)?.cursor??input.after??'0'};
  }),
  deliveries:(org:string,input:{limit:number})=>options.transact(org,async tx=>{
   await requireActiveOrganization(tx,org);
   return {data:(await tx.query<{id:string;endpointId:string;eventId:string;status:string;attempts:number;lastErrorCode:string|null;availableAt:Date;updatedAt:Date}>(`SELECT id,endpoint_id AS "endpointId",event_id AS "eventId",status,attempts,last_error_code AS "lastErrorCode",available_at AS "availableAt",updated_at AS "updatedAt" FROM partner_event_deliveries WHERE organization_id=$1 ORDER BY updated_at DESC,id LIMIT $2`,[org,input.limit])).rows.map(row=>({...row,availableAt:row.availableAt.toISOString(),updatedAt:row.updatedAt.toISOString()}))};
  }),
 };
}
export type PartnerEventService=ReturnType<typeof createPartnerEventService>;
