import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {MessageState} from './types.js';

const transitions:Readonly<Record<MessageState,ReadonlySet<MessageState>>>={
  ACCEPTED:new Set(['ACCEPTED','SENDING','FAILED']),SENDING:new Set(['SENDING','SENT','FAILED','UNKNOWN']),
  SENT:new Set(['SENT','DELIVERED','READ','FAILED']),DELIVERED:new Set(['DELIVERED','READ']),READ:new Set(['READ']),
  FAILED:new Set(['FAILED']),UNKNOWN:new Set(['UNKNOWN','SENT','DELIVERED','READ','FAILED']),
};
export function canAdvanceMessageState(from:MessageState,to:MessageState):boolean{return transitions[from].has(to);}

export async function lockMessageStatusKey(tx:TenantTransaction,org:string,channel:string,providerId:string):Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31),$1::text,$2::text,$3::text),0))`,[org,channel,providerId]);
}
