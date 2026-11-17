import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import { AttendanceError } from '../attendance/types.js';
import { readLatestHistorySyncProgress } from './progress.js';

/** Scalar-only observation; cannot admit a run, process a page, download media,
 * reconnect a phone or change the current owner. IDs here are canonical channels. */
export function createHistorySyncProgressService(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}) {
  return {latest:(org:string,actor:string,channel:string)=>options.transact(org,async tx=>{
    const active=(await tx.query<{active:boolean}>('SELECT tenant_is_active($1) AS active',[org])).rows[0]?.active;
    const member=(await tx.query<{role:string}>('SELECT role FROM lock_local_attendance_member($1)',[actor])).rows[0];
    if(!active || !member)throw new AttendanceError('HISTORY_SYNC_FORBIDDEN',403);
    if(!(await tx.query('SELECT 1 FROM messaging_channels WHERE organization_id=$1 AND id=$2 AND deleting_at IS NULL',[org,channel])).rowCount)
      throw new AttendanceError('HISTORY_SYNC_NOT_FOUND',404);
    return readLatestHistorySyncProgress(tx,org,channel);
  })};
}
export type HistorySyncProgressService=ReturnType<typeof createHistorySyncProgressService>;
