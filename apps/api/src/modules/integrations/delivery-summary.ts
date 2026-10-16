import {IntegrationDeliveryIssueCodeSchema,IntegrationDeliverySummarySchema} from '@jrc/contracts';
import type {TenantTransaction} from '../../db/tenant-transaction.js';

/** Counts the full tenant backlog; no message body, token or remote error text is projected. */
export async function readDeliverySummary(tx:TenantTransaction,organizationId:string){
 const known=IntegrationDeliveryIssueCodeSchema.options.filter(code=>code!=='OTHER');
 const result=await tx.query<{status:string;code:string;total:string;first_seen_at:Date;last_seen_at:Date}>(`
  SELECT status,CASE WHEN last_error=ANY($2::text[]) THEN last_error ELSE 'OTHER' END AS code,
   count(*)::text AS total,min(created_at) AS first_seen_at,max(created_at) AS last_seen_at
  FROM integration_jobs WHERE organization_id=$1 AND status IN ('FAILED','UNKNOWN')
  GROUP BY status,CASE WHEN last_error=ANY($2::text[]) THEN last_error ELSE 'OTHER' END
  ORDER BY status,code`,[organizationId,known]);
 return IntegrationDeliverySummarySchema.parse({data:result.rows.map(row=>({
  status:row.status,code:row.code,total:Number(row.total),
  firstSeenAt:row.first_seen_at.toISOString(),lastSeenAt:row.last_seen_at.toISOString(),
 }))});
}
