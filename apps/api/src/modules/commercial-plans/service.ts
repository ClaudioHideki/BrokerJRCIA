import type { PoolClient } from 'pg';
import { CommercialAssignmentSchema, CommercialPlanVersionSchema, type CommercialOverrides } from '@jrc/contracts';

const versionColumns='v.id,v.plan_id AS "planId",v.version,v.name,v.limits,v.flows_enabled AS "flowsEnabled"';
export async function listCommercialPlans(c:PoolClient){
 const result=await c.query(`SELECT ${versionColumns} FROM commercial_plan_versions v JOIN commercial_plans p ON p.id=v.plan_id WHERE NOT p.legacy ORDER BY p.name,p.id,v.version DESC`);
 return {data:result.rows.map(row=>CommercialPlanVersionSchema.parse(row))};
}
export async function insertCommercialVersion(c:PoolClient,planId:string,version:number,name:string,limits:unknown,flowsEnabled:boolean,organizationId:string|null=null){
 const row=(await c.query(`INSERT INTO commercial_plan_versions(plan_id,version,name,limits,flows_enabled,organization_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,plan_id AS "planId",version,name,limits,flows_enabled AS "flowsEnabled"`,[planId,version,name,JSON.stringify(limits),flowsEnabled,organizationId])).rows[0];
 return CommercialPlanVersionSchema.parse(row);
}
export async function readCommercialAssignment(c:PoolClient,org:string){
 const result=await c.query(`SELECT o.id AS "organizationId",coalesce(a.revision,0) AS revision,a.plan_version_id AS "planVersionId",o.plan AS name,v.version,
  json_build_object('maxInstances',l.max_instances,'maxUsers',l.max_users,'messagesPerDay',l.messages_per_day,'maxPendingMessages',l.max_pending_messages) AS limits,
  coalesce(f.enabled,false) AS "flowsEnabled",coalesce(a.overrides,'{}'::jsonb) AS overrides,
  json_build_object('connections',(SELECT count(*) FROM instances WHERE organization_id=o.id AND archived_at IS NULL)+(SELECT count(*) FROM messaging_channels WHERE organization_id=o.id AND provider='META'),
   'users',(SELECT count(*) FROM memberships WHERE organization_id=o.id AND status='ACTIVE'),
   'messagesAcceptedToday',coalesce((SELECT accepted_messages FROM organization_message_usage WHERE organization_id=o.id AND usage_day=(statement_timestamp() AT TIME ZONE 'UTC')::date),0),
   'pendingMessages',(SELECT count(*) FROM messaging_messages WHERE organization_id=o.id AND direction='OUTGOING' AND state IN ('ACCEPTED','SENDING','UNKNOWN')),
   'storageBytes',NULL,'aiTokens',NULL) AS usage
  FROM organizations o JOIN organization_limits l ON l.organization_id=o.id
  LEFT JOIN organization_commercial_plans a ON a.organization_id=o.id LEFT JOIN commercial_plan_versions v ON v.id=a.plan_version_id
  LEFT JOIN flow_features f ON f.organization_id=o.id WHERE o.id=$1`,[org]);
 return result.rows[0]?CommercialAssignmentSchema.parse(result.rows[0]):null;
}
/** Called inside the platform transaction after locking the organization first. */
export async function projectCommercialAssignment(c:PoolClient,org:string,versionId:string,overrides:CommercialOverrides){
 const row=(await c.query(`SELECT ${versionColumns} FROM commercial_plan_versions v WHERE v.id=$1 AND (v.organization_id IS NULL OR v.organization_id=$2)`,[versionId,org])).rows[0];
 if(!row)return null;
 const version=CommercialPlanVersionSchema.parse(row),effective={...version.limits,...overrides};
 await c.query('UPDATE organization_limits SET max_instances=$2,max_users=$3,messages_per_day=$4,max_pending_messages=$5,updated_at=now() WHERE organization_id=$1',[org,effective.maxInstances,effective.maxUsers,effective.messagesPerDay,effective.maxPendingMessages]);
 await c.query('UPDATE organizations SET plan=$2,updated_at=now() WHERE id=$1',[org,version.name]);
 await c.query(`INSERT INTO flow_features(organization_id,enabled) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET enabled=excluded.enabled,revision=flow_features.revision+1,updated_at=now() WHERE flow_features.enabled IS DISTINCT FROM excluded.enabled`,[org,overrides.flowsEnabled??version.flowsEnabled]);
 await c.query(`INSERT INTO organization_commercial_plans(organization_id,plan_version_id,overrides) VALUES($1,$2,$3) ON CONFLICT(organization_id) DO UPDATE SET plan_version_id=$2,overrides=$3,revision=organization_commercial_plans.revision+1,updated_at=now()`,[org,versionId,JSON.stringify(overrides)]);
 return readCommercialAssignment(c,org);
}
/** Compatibility writes capture the actual effective values and invalidate old CAS forms. */
export async function snapshotLegacyCommercialAssignment(c:PoolClient,org:string){
 const current=await readCommercialAssignment(c,org);if(!current)throw new Error('Missing organization limits');
 const plan=(await c.query('INSERT INTO commercial_plans(name,legacy,organization_id) VALUES($1,true,$2) RETURNING id',[current.name,org])).rows[0];
 const version=await insertCommercialVersion(c,plan.id,1,current.name,current.limits,current.flowsEnabled,org);
 const assignment=(await c.query(`INSERT INTO organization_commercial_plans(organization_id,plan_version_id) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET plan_version_id=$2,overrides='{}'::jsonb,revision=organization_commercial_plans.revision+1,updated_at=now() RETURNING revision`,[org,version.id])).rows[0];
 return {planVersionId:version.id,revision:assignment.revision as number};
}
