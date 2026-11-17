import type {OrganizationTransaction,TenantTransaction} from '../../db/tenant-transaction.js';
import type {EvolutionFleetRuntime} from '../evolution-fleet/runtime.js';
import type {ChatwootControlAuth,ChatwootControlPrincipal} from '../integrations/chatwoot-control-auth.js';
import {createHmac} from 'node:crypto';

/** Called only by a new authorized onboarding operation. Installing a release
 * never enables existing channels or changes a selected group policy. */
export type HistoryConnectionAdmission=(p:ChatwootControlPrincipal,channel:string,request:string,validate:(tx:TenantTransaction)=>Promise<void>)=>Promise<void>;
export function createHistoryConnectionAdmission(options:{auth:ChatwootControlAuth;fleet:EvolutionFleetRuntime;signingKey:string;
  transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}):HistoryConnectionAdmission{
  return async(p:ChatwootControlPrincipal,channel:string,request:string,validate:(tx:TenantTransaction)=>Promise<void>)=>{
    await options.transact(p.organizationId,async tx=>{
      await validate(tx);await options.auth.revalidate(tx,p,'chatwoot:manage');
      const row=(await tx.query<{upstream_instance_key:string}>(`SELECT i.upstream_instance_key FROM messaging_channels c
        JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
        WHERE c.organization_id=$1 AND c.id=$2 AND c.provider='BAILEYS' AND c.transport='BROKER_TRANSPORT' AND c.deleting_at IS NULL AND i.archived_at IS NULL`,[p.organizationId,channel])).rows[0];
      if(!row)throw Error('HISTORY_SYNC_CHANNEL_UNAVAILABLE');
      const engine=await options.fleet.capture(p.organizationId,row.upstream_instance_key,undefined,tx);
      await options.fleet.assert(engine,tx);
      const actor=p.authentication;
      const qrBindingFingerprint=createHmac('sha256',options.signingKey).update(JSON.stringify(['qr-engine:v1',engine.engineId,
        engine.generation,engine.destinationFingerprint,engine.traditional])).digest('hex');
      await tx.query('SELECT history_sync_enable_connection($1,$2,$3,$4,$5,$6)',[p.organizationId,channel,actor.actorId,request,{...engine,qrBindingFingerprint},
        actor.kind==='API_KEY'?actor.apiKeyId:null]);
      await tx.query(`INSERT INTO whatsapp_group_catalogs(organization_id,channel_id) VALUES($1,$2) ON CONFLICT(organization_id,channel_id) DO NOTHING`,[p.organizationId,channel]);
      await options.auth.audit(tx,p,'HISTORY_SOURCE_ADMITTED',channel);
    });
  };
}
