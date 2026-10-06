import { AutomationHandoffConfigSchema, type AttendanceCatalog, type AttendanceScope, type AutomationGraphV1, type HumanTarget } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import { readChatwootAccount } from '../integrations/chatwoot-context.js';
import { requireActiveOrganization } from '../tenancy/operational-limits.js';
import { resolveAttendanceScope } from './repository.js';
import { AttendanceError } from './types.js';
import { assertStandaloneDestination } from './destination-adapter.js';

export interface PreparedHandoffReadiness { assertCurrent(tx:TenantTransaction):Promise<void> }
export interface HandoffReadiness { prepare(org:string,graph:AutomationGraphV1,channelId?:string):Promise<PreparedHandoffReadiness> }
type TargetValidation={scope:AttendanceScope;credentialRevision:number};
type Options={
  transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;
  catalog?(org:string,integrationId:string):Promise<AttendanceCatalog>;
  validateTarget?(scope:AttendanceScope,target:HumanTarget):Promise<TargetValidation>;
};
const sameScope=(a:AttendanceScope,b:AttendanceScope)=>Object.keys(a).every(key=>a[key as keyof AttendanceScope]===b[key as keyof AttendanceScope]);

/** No remote calls occur while the publication/binding transaction holds locks. */
export function createHandoffReadiness(options:Options):HandoffReadiness {
  return {async prepare(org,graph,channelId){
    const snapshots:Array<{scope:AttendanceScope;credentialRevision:number;baseUrl:string}>=[];
    const localChannels=new Set<string>();
    for(const node of graph.nodes.filter(n=>n.type==='handoff')){
      const parsed=AutomationHandoffConfigSchema.safeParse(node.data);
      if(!parsed.success)throw new AttendanceError('AUTOMATION_HANDOFF_DESTINATION_REQUIRED',422);
      const config=parsed.data;
      if(config.handoffVersion===2){
        if(config.destination.organizationId!==org)throw new AttendanceError('HANDOFF_SCOPE_MISMATCH',409);
        if(channelId!==undefined&&config.destination.channelId!==channelId)throw new AttendanceError('ATTENDANCE_HANDOFF_CHANNEL_MISMATCH',409);
        await options.transact(org,tx=>assertStandaloneDestination(tx,org,config.destination.channelId));
        localChannels.add(config.destination.channelId);continue;
      }
      if(!options.catalog||!options.validateTarget)throw new AttendanceError('AUTOMATION_HANDOFF_UNAVAILABLE',409);
      const snapshot=await options.transact(org,async tx=>{
        await requireActiveOrganization(tx,org);
        const connection=(await tx.query<{channel_id:string}>(`SELECT channel_id FROM chatwoot_connections WHERE organization_id=$1 AND id=$2 FOR SHARE`,[org,config.destination.integrationId])).rows[0];
        if(!connection)throw new AttendanceError('ATTENDANCE_DESTINATION_NOT_FOUND',404);
        if(channelId!==undefined&&connection.channel_id!==channelId)throw new AttendanceError('ATTENDANCE_HANDOFF_CHANNEL_MISMATCH',409);
        const scope=await resolveAttendanceScope(tx,org,connection.channel_id),account=await readChatwootAccount(tx,org);
        if(!scope||!account||scope.integrationId!==config.destination.integrationId||scope.destinationRevision!==config.destination.destinationRevision||
          scope.accountId!==config.destination.accountId||scope.inboxId!==config.destination.inboxId||account.credential_version!==config.destination.credentialRevision)
          throw new AttendanceError('CHATWOOT_CONTEXT_CHANGED',409);
        return {scope,credentialRevision:account.credential_version,baseUrl:account.base_url};
      });
      const catalog=await options.catalog(org,config.destination.integrationId);
      if(!sameScope(snapshot.scope,catalog.scope)||snapshot.credentialRevision!==catalog.credentialRevision)throw new AttendanceError('CHATWOOT_CONTEXT_CHANGED',409);
      if(catalog.inboxPolicy.greetingEnabled!==false)throw new AttendanceError('ATTENDANCE_DISABLE_INBOX_GREETING',409);
      if(catalog.inboxPolicy.autoAssignmentEnabled!==false)throw new AttendanceError('ATTENDANCE_DISABLE_INBOX_AUTO_ASSIGNMENT',409);
      if(catalog.capabilities.agentBot!=='SUPPORTED'||catalog.remoteBot!==null)throw new AttendanceError('ATTENDANCE_REMOVE_COMPETING_AGENT_BOT',409);
      if(config.target.teamId!==null&&catalog.teams.find(team=>team.id===config.target.teamId)?.autoAssignment!==false)
        throw new AttendanceError('ATTENDANCE_DISABLE_TEAM_AUTO_ASSIGNMENT',409);
      const target=await options.validateTarget(snapshot.scope,config.target);
      if(!sameScope(snapshot.scope,target.scope)||snapshot.credentialRevision!==target.credentialRevision)throw new AttendanceError('CHATWOOT_CONTEXT_CHANGED',409);
      snapshots.push(snapshot);
    }
    return {async assertCurrent(tx){
      for(const localChannel of localChannels)await assertStandaloneDestination(tx,org,localChannel);
      for(const expected of snapshots){
        const scope=await resolveAttendanceScope(tx,org,expected.scope.channelId),account=await readChatwootAccount(tx,org);
        if(!scope||!account||!sameScope(scope,expected.scope)||account.credential_version!==expected.credentialRevision||account.base_url!==expected.baseUrl)
          throw new AttendanceError('CHATWOOT_CONTEXT_CHANGED',409);
      }
    }};
  }};
}
