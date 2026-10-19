import type {OrganizationTransaction} from '../../db/tenant-transaction.js';
import type {HistoryImportService} from './types.js';
interface Options {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;service:HistoryImportService}
/** Only advances previously admitted imports. It cannot create an import, activate a flow or send a message. */
export function createHistoryImportWorker(options:Options){return{runOnce:async(org:string,signal?:AbortSignal)=>{
 const jobs=await options.transact(org,async tx=>{
  await tx.query('SELECT history_import_expire_snapshots()');
  return(await tx.query<{id:string;actor_id:string;instance_id:string;revision:string}>(`SELECT j.id,j.actor_id,c.instance_id,j.revision FROM history_import_jobs j
   JOIN messaging_channels c ON c.organization_id=j.organization_id AND c.id=j.channel_id
   WHERE j.organization_id=$1 AND j.state='OPEN' AND j.actor_id IS NOT NULL AND j.next_attempt_at<=statement_timestamp() AND c.instance_id IS NOT NULL
   ORDER BY j.next_attempt_at,j.created_at,j.id LIMIT 10`,[org])).rows;
 });
 for(const job of jobs){if(signal?.aborted)break;try{await options.service.advance(org,job.actor_id,job.instance_id,job.id);}catch(error){
  const candidate=(error as {code?:unknown})?.code;
  const code=typeof candidate==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)?candidate:'HISTORY_SOURCE_UNAVAILABLE';
  await options.transact(org,tx=>tx.query(`UPDATE history_import_jobs SET last_error=$3,next_attempt_at=statement_timestamp()+interval '1 minute',revision=revision+1,updated_at=now()
   WHERE organization_id=$1 AND id=$2 AND state='OPEN' AND revision=$4`,[org,job.id,code,job.revision]));
 }}
 }};}
