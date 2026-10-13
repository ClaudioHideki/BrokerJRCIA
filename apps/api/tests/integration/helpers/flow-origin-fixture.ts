import {randomUUID} from 'node:crypto';
import type {IsolatedPostgresDatabase} from './postgres.js';
/** Synthetic reviewed deployment evidence for service tests only. Tests of the
 * approval hook exercise the real platform session/CSRF transaction separately. */
export async function approveOriginFixture(db:IsolatedPostgresDatabase,org:string,kind:'STOCK'|'JRC_NATIVE'){
 const actor=randomUUID();
 await db.pool.query("INSERT INTO platform_users(id,email,password_hash,role,mfa_seed) VALUES($1,$2,'synthetic-only','SUPER_ADMIN','synthetic-only')",[actor,`${actor}@example.test`]);
 const audit=(await db.pool.query("INSERT INTO platform_audit_logs(actor_id,organization_id,action,reason) VALUES($1,NULL,'flow-origin-approve','Synthetic verified deployment fixture') RETURNING id",[actor])).rows[0]!.id;
 const origin=(await db.pool.query('SELECT base_url FROM chatwoot_destinations WHERE organization_id=$1',[org])).rows[0]!.base_url;
 await db.pool.query(`INSERT INTO flow_executor_origins(base_url,kind,provenance,approval_audit_id,host_source_sha,host_image_digest,fence_protocol_version)
  VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(base_url) DO UPDATE SET kind=excluded.kind,provenance=excluded.provenance,revision=flow_executor_origins.revision+1,approval_audit_id=excluded.approval_audit_id,host_source_sha=excluded.host_source_sha,host_image_digest=excluded.host_image_digest,fence_protocol_version=excluded.fence_protocol_version`,[origin,kind,kind==='STOCK'?'PLATFORM_DESTINATION_APPROVAL':'AUTHENTICATED_JRC_BFF',audit,kind==='JRC_NATIVE'?'a'.repeat(40):null,kind==='JRC_NATIVE'?`sha256:${'b'.repeat(64)}`:null,kind==='JRC_NATIVE'?1:null]);
}
