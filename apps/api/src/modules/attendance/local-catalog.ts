import type { OrganizationTransaction } from '../../db/tenant-transaction.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { assertStandaloneDestination } from './destination-adapter.js';
import { AttendanceError } from './types.js';

export function createLocalAttendanceCatalog(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}){
 return {listChannels:async(org:string)=>options.transact(org,async tx=>{
  await requireActiveOrganization(tx,org);
  const channels=(await tx.query<{id:string;name:string}>(`SELECT c.id,coalesce(nullif(i.name,''),'Caixa '||left(c.id::text,8)) AS name
   FROM messaging_channels c LEFT JOIN instances i ON i.organization_id=c.organization_id AND i.id=c.instance_id
   WHERE c.organization_id=$1 AND c.deleting_at IS NULL AND (i.id IS NULL OR i.archived_at IS NULL)
   ORDER BY c.created_at,c.id LIMIT 10001`,[org])).rows;
  if(channels.length>10000)throw new AttendanceError('ATTENDANCE_CATALOG_TOO_LARGE',409);
  const data=[];
  for(const channel of channels){
   try{data.push({scope:await assertStandaloneDestination(tx,org,channel.id),name:channel.name});}
   catch(error){if(!(error instanceof AttendanceError)||!['ATTENDANCE_CENTRAL_CONFIGURED','CHANNEL_ARCHIVED'].includes(error.code))throw error;}
  }
  return data;
 })};
}
