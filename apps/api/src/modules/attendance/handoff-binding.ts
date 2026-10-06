import { AutomationGraphV1Schema, AutomationHandoffConfigSchema, type AutomationGraphV1 } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { readChatwootAccount } from '../integrations/chatwoot-context.js';
import { resolveAttendanceScope } from './repository.js';
import { AttendanceError } from './types.js';
import { assertStandaloneDestination } from './destination-adapter.js';

/** Common local admission for every native owner path. Remote policy/target
 * readiness belongs to asynchronous publication and, decisively, dispatch. */
export async function assertHandoffBinding(tx:TenantTransaction,org:string,channelId:string,automationId:string,version:number){
  const seen=new Set<string>();
  const visit=async(id:string,v:number):Promise<void>=>{
    const key=`${id}:${v}`;if(seen.has(key))return;seen.add(key);
    const row=(await tx.query<{graph:AutomationGraphV1}>('SELECT graph FROM automation_versions WHERE organization_id=$1 AND automation_id=$2 AND version=$3',[org,id,v])).rows[0];
    if(!row)throw new AttendanceError('AUTOMATION_VERSION_NOT_FOUND',404);
    const parsed=AutomationGraphV1Schema.safeParse(row.graph);if(!parsed.success)throw new AttendanceError('AUTOMATION_PUBLISHED_GRAPH_INVALID',409);
    const graph=parsed.data,reachable=new Set<string>(),walk=(nodeId:string)=>{if(reachable.has(nodeId))return;reachable.add(nodeId);for(const edge of graph.edges.filter(e=>e.source===nodeId))walk(edge.target);};
    for(const node of graph.nodes.filter(n=>n.type==='start'))walk(node.id);
    for(const node of graph.nodes.filter(n=>reachable.has(n.id))){
      if(node.type==='handoff'){
        const configured=AutomationHandoffConfigSchema.safeParse(node.data);
        if(!configured.success)throw new AttendanceError('ATTENDANCE_HANDOFF_DESTINATION_REQUIRED',409);
        if(configured.data.handoffVersion===2){
          if(configured.data.destination.organizationId!==org||configured.data.destination.channelId!==channelId)throw new AttendanceError('ATTENDANCE_HANDOFF_CONTEXT_CHANGED',409);
          await assertStandaloneDestination(tx,org,channelId);continue;
        }
        const scope=await resolveAttendanceScope(tx,org,channelId),account=await readChatwootAccount(tx,org),d=configured.data.destination;
        if(!scope||!account||scope.integrationId!==d.integrationId||scope.destinationRevision!==d.destinationRevision||scope.accountId!==d.accountId||scope.inboxId!==d.inboxId||account.credential_version!==d.credentialRevision)
          throw new AttendanceError('ATTENDANCE_HANDOFF_CONTEXT_CHANGED',409);
      }
      if(node.type==='subflow')await visit(String(node.data.automationId),Number(node.data.version));
    }
  };
  await visit(automationId,version);
}
