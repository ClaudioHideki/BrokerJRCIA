import type {Pool} from 'pg';
import type {ChatwootStatus} from '@jrc/contracts';
import {z} from 'zod';
import {normalizeChatwootOrigin} from '../../integrations/chatwoot-destination.js';
import type {OrganizationTransaction} from '../../../db/tenant-transaction.js';
import type {VerifiedNativeDeployment} from './origin-approval.js';
export function createFlowSessionResolver(pool:Pick<Pool,'query'>){return async(digest:string):Promise<string|null>=>{
 if(!/^[a-f0-9]{64}$/.test(digest))return null;
 const row=(await pool.query<{organization_id:string|null}>('SELECT resolve_flow_delegation_session($1) AS organization_id',[digest])).rows[0];return row?.organization_id??null;
};}
/** Uses the credential lookup already installed by P9 0053; authPool only. */
export function createFlowCredentialResolver(pool:Pick<Pool,'query'>){return async(digest:string):Promise<string|null>=>{
 if(!/^[a-f0-9]{64}$/.test(digest))return null;
 const row=(await pool.query<{organization_id:string|null}>('SELECT resolve_flow_delegation_credential($1) AS organization_id',[digest])).rows[0];return row?.organization_id??null;
};}
/** Only trusted server configuration can declare our native origins/deployment.
 * Source references and browser declarations never populate this inventory. */
export function loadFlowOriginRuntimeOptions(environment:NodeJS.ProcessEnv){
 const knownNativeOrigins=new Set([environment.CHATWOOT_BASE_URL,...(environment.FLOW_KNOWN_NATIVE_ORIGINS??'').split(',')].filter((value):value is string=>Boolean(value?.trim())).map(value=>normalizeChatwootOrigin(value.trim())));
 const deployment=z.strictObject({origin:z.string(),kind:z.literal('JRC_NATIVE'),provenance:z.enum(['AUTHENTICATED_JRC_BFF','VERIFIED_DEPLOYMENT']),hostSourceSha:z.string().regex(/^[a-f0-9]{40}$/),hostImageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),fenceProtocolVersion:z.number().int().positive()});
 const values=z.array(deployment).max(100).parse(JSON.parse(environment.FLOW_NATIVE_DEPLOYMENTS_JSON?.trim()||'[]'));
 const nativeDeployments=new Map<string,VerifiedNativeDeployment>();for(const value of values){const {origin,...proof}=value,key=normalizeChatwootOrigin(origin);if(nativeDeployments.has(key))throw new Error('FLOW_DUPLICATE_NATIVE_ORIGIN');knownNativeOrigins.add(key);nativeDeployments.set(key,proof);}
 return {knownNativeOrigins,nativeDeployments};
}
export function projectFlowDestinationStatus(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;knownNativeOrigins:ReadonlySet<string>}){
 return async<S extends ChatwootStatus>(org:string,status:S):Promise<S>=>{
  if(!status.destination)return status;
  const origin=normalizeChatwootOrigin(status.destination.baseUrl),row=await options.transact(org,async tx=>(await tx.query<{kind:'STOCK'|'JRC_NATIVE';revision:number;revoked_at:Date|null}>('SELECT kind,revision,revoked_at FROM flow_executor_origins WHERE base_url=$1',[origin])).rows[0]);
  const native=options.knownNativeOrigins.has(origin),flowExecutor=row&&!row.revoked_at&&(!native||row.kind==='JRC_NATIVE')?{kind:row.kind,revision:row.revision,status:'READY' as const}:
   {kind:native?'JRC_NATIVE' as const:null,revision:row?.revision??0,status:native?'NATIVE_EVIDENCE_REQUIRED' as const:row?.revoked_at?'REVOKED' as const:'DECLARATION_REQUIRED' as const};
  return {...status,destination:{...status.destination,flowExecutor}};
 };
}
