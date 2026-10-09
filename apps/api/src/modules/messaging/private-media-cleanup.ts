import type { LifecycleTransaction } from '../lifecycle/service.js';
import type { DurablePrivateMediaStore } from './durable-private-media.js';
export type PrivateMediaCleanupState='COMPLETE'|'PENDING'|'UNKNOWN';
export function createPrivateMediaCleanup(transact:LifecycleTransaction,
  store?:Pick<DurablePrivateMediaStore,'prepareCleanup'|'runCleanupOnce'>) {
  return async (id:string,lease:string):Promise<{state:PrivateMediaCleanupState}>=>{
    const readScope=()=>transact(async tx=>{
      const deletion=(await tx.query<{organization_id:string;kind:string;messaging_channel_id:string|null}>(
        `SELECT organization_id,kind,messaging_channel_id FROM lifecycle_deletions
          WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp()
          AND status IN ('CLEANING_EXTERNAL','REMOVING_DATA')`,[id,lease])).rows[0];
      if(!deletion || !['CHANNEL','ORGANIZATION'].includes(deletion.kind))throw new Error('LIFECYCLE_LEASE_LOST');
      return deletion;
    });
    const initial=await readScope();
    // A physical QR instance need not have a messaging channel yet. Its
    // nominative deletion never covers the other boxes in the company.
    if(initial.kind==='CHANNEL' && initial.messaging_channel_id===null)return {state:'COMPLETE'};
    if(store){
      await store.prepareCleanup(id,lease);
      await store.runCleanupOnce(id,lease);
    }
    const deletion=await readScope();
    return transact(async tx=>{
      const result=(await tx.query<{pending:boolean;uncertain:boolean}>(`SELECT
        EXISTS(SELECT 1 FROM media_private_objects o WHERE o.organization_id=$1
          AND($3='ORGANIZATION' OR o.channel_id=$2) AND o.state NOT IN ('DELETED','REJECTED'))
        OR EXISTS(SELECT 1 FROM media_private_operations p WHERE p.organization_id=$1
          AND($3='ORGANIZATION' OR p.channel_id=$2) AND p.kind='DELETE' AND p.state<>'CONFIRMED') AS pending,
        EXISTS(SELECT 1 FROM media_private_operations p WHERE p.organization_id=$1
          AND($3='ORGANIZATION' OR p.channel_id=$2)
          AND(p.state IN ('DISPATCHED','UNKNOWN') OR p.lease_token IS NOT NULL OR(p.kind='DELETE' AND p.state='REJECTED'))) AS uncertain`,
        [deletion.organization_id,deletion.messaging_channel_id,deletion.kind])).rows[0];
      if(!result)throw new Error('MEDIA_PRIVATE_CLEANUP_UNVERIFIED');
      if(result.uncertain || (result.pending && !store))return {state:'UNKNOWN'};
      return {state:result.pending?'PENDING':'COMPLETE'};
    });
  };
}
