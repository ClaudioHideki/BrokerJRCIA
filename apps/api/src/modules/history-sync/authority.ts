import { createHmac,randomUUID,timingSafeEqual } from 'node:crypto';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import type { EvolutionFleetRuntime } from '../evolution-fleet/runtime.js';
import { lockAttendanceChannel } from '../attendance/repository.js';
import { HistorySyncScopeSchema,historyLogicalOwnerFingerprint,type HistorySyncScope } from './contract.js';

type Options={fleet:Pick<EvolutionFleetRuntime,'capture'|'assert'>;signingKey:string};
type Current={instance_id:string;upstream_instance_key:string;scope_id:string;owner_fingerprint:string|null;binding_fingerprint:string};
export interface HistoryRuntimeAuthority{
  resolve(tx:TenantTransaction,org:string,channel:string,sessionGeneration:string,sourceOwnerPhone:string|null):Promise<HistorySyncScope>;
  assertCurrentScope(tx:TenantTransaction,scope:HistorySyncScope):Promise<void>;
}
function fail(code:string):never{throw Error(code);}
/** Broker-side authority. It never accepts tenant, engine or owner metadata from
 * a public request. Callers additionally fence their admitted source session.
 * All revocation locks below belong to the caller's COMMIT, not a prior read. */
export function createHistoryRuntimeAuthority(options:Options):HistoryRuntimeAuthority{
  if(typeof options.signingKey!=='string'||Buffer.byteLength(options.signingKey)<32)fail('HISTORY_SYNC_AUTHORITY_CONFIG_INVALID');
  const current=async(tx:TenantTransaction,org:string,channel:string)=>{
    await lockAttendanceChannel(tx,org,channel);
    const row=(await tx.query<Current>(`SELECT i.id AS instance_id,i.upstream_instance_key,s.scope_id,s.owner_fingerprint,s.binding_fingerprint
      FROM messaging_channels c JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
      JOIN qr_identity_scopes s ON s.organization_id=c.organization_id AND s.channel_id=c.id
        AND s.instance_id=i.id AND s.upstream_instance_key=i.upstream_instance_key
      WHERE c.organization_id=$1 AND c.id=$2 AND c.provider='BAILEYS' AND c.transport='BROKER_TRANSPORT'
        AND c.deleting_at IS NULL AND i.archived_at IS NULL FOR SHARE OF i,s`,[org,channel])).rows[0];
    if(!row)fail('HISTORY_SYNC_CHANNEL_UNAVAILABLE');
    const engine=await options.fleet.capture(org,row.upstream_instance_key,undefined,tx);
    if(engine.state==='DISABLED')fail('HISTORY_SYNC_BINDING_CHANGED');
    await options.fleet.assert(engine,tx);
    const expected=createHmac('sha256',options.signingKey).update(JSON.stringify(['qr-engine:v1',engine.engineId,
      engine.generation,engine.destinationFingerprint,engine.traditional])).digest('hex');
    if(row.binding_fingerprint!==expected)fail('HISTORY_SYNC_BINDING_CHANGED');
    return{row,engine};
  };
  return{
    async resolve(tx:TenantTransaction,org:string,channel:string,sessionGeneration:string,sourceOwnerPhone:string|null):Promise<HistorySyncScope>{
      const {row,engine}=await current(tx,org,channel);
      const scope:HistorySyncScope={organizationId:org,channelId:channel,instanceId:row.instance_id,engineId:engine.engineId,
        engineGeneration:engine.generation,sessionGeneration,bindingFingerprint:row.binding_fingerprint,
        identityScopeId:null,historyAccountIdentity:null,ownerFingerprint:null};
      if(sourceOwnerPhone!==null){
        if(!/^[1-9]\d{7,14}$/u.test(sourceOwnerPhone)||!row.owner_fingerprint)fail('HISTORY_SYNC_OWNER_UNVERIFIED');
        const claimed=createHmac('sha256',options.signingKey).update(`qr-identity:v1:${org}:${channel}:${row.upstream_instance_key}:${sourceOwnerPhone}`).digest();
        if(!/^[a-f0-9]{64}$/u.test(row.owner_fingerprint)||!timingSafeEqual(claimed,Buffer.from(row.owner_fingerprint,'hex')))
          fail('HISTORY_SYNC_OWNER_UNVERIFIED');
        const fingerprint=historyLogicalOwnerFingerprint(options.signingKey,org,channel,sourceOwnerPhone);
        const identity=(await tx.query<{id:string}>(`INSERT INTO history_account_identities(organization_id,id,channel_id,owner_fingerprint)
          VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,channel_id,owner_fingerprint)
          DO UPDATE SET owner_fingerprint=EXCLUDED.owner_fingerprint RETURNING id`,[org,randomUUID(),channel,fingerprint])).rows[0]!;
        Object.assign(scope,{identityScopeId:row.scope_id,historyAccountIdentity:identity.id,ownerFingerprint:fingerprint});
      }
      return Object.freeze(HistorySyncScopeSchema.parse(scope));
    },
    async assertCurrentScope(tx:TenantTransaction,rawScope:HistorySyncScope){
      const scope=HistorySyncScopeSchema.parse(rawScope),{row,engine}=await current(tx,scope.organizationId,scope.channelId);
      if(row.instance_id!==scope.instanceId||row.binding_fingerprint!==scope.bindingFingerprint
        ||engine.engineId!==scope.engineId||engine.generation!==scope.engineGeneration
        ||scope.identityScopeId!==null&&row.scope_id!==scope.identityScopeId)fail('HISTORY_SYNC_SCOPE_CHANGED');
      if(scope.historyAccountIdentity!==null&&!(await tx.query(`SELECT 1 FROM history_account_identities WHERE organization_id=$1
        AND channel_id=$2 AND id=$3 AND owner_fingerprint=$4`,[scope.organizationId,scope.channelId,scope.historyAccountIdentity,scope.ownerFingerprint])).rowCount)
        fail('HISTORY_SYNC_SCOPE_CHANGED');
    },
  };
}
