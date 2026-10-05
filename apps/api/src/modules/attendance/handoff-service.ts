import type { AttendanceCatalog, AttendanceScope, HumanTarget } from '@jrc/contracts';
import type { OutboxRow } from '../automations/repository.js';
import type { OutboxDispatchResult } from '../automations/service.js';
import type { ChatwootClient } from '../integrations/chatwoot-client.js';
import type { AccountRow } from '../integrations/chatwoot-context.js';
import { createPostgresHandoffRepository } from './handoff-repository.js';
import { NativeHandoffError, type HandoffOperation, type HandoffRepository, type HandoffTransactions } from './handoff-types.js';

type Canonical=Awaited<ReturnType<ChatwootClient['attendanceConversation']>>;
interface Options extends HandoffTransactions {
  client(account:AccountRow):ChatwootClient;
  attendanceService:{
    validateTarget(scope:AttendanceScope,target:HumanTarget):Promise<{credentialRevision:number}>;
    catalog(org:string,integrationId:string):Promise<AttendanceCatalog>;
  };
  repository?:HandoffRepository;
}
const errorCode=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)?error.message:'HANDOFF_VALIDATION_FAILED';
function scoped(op:HandoffOperation,value:Canonical) {
  const s=op.snapshot!;
  if(value.id!==s.remoteConversationId||value.account_id!==s.scope.accountId||value.inbox_id!==s.scope.inboxId)
    throw new NativeHandoffError('HANDOFF_REMOTE_SCOPE_MISMATCH');
}
function unassigned(op:HandoffOperation,value:Canonical,opening:boolean) {
  scoped(op,value);
  if(value.meta.assignee!==null||value.meta.team!==null||value.meta.assignee_type!=null||
    value.status!==(opening?'pending':'open'))throw new NativeHandoffError('HANDOFF_REMOTE_CONTROL_CHANGED');
}
function confirmed(op:HandoffOperation,value:Canonical) {
  scoped(op,value);const target=op.snapshot!.target;
  const human=(value.meta.assignee?.type===undefined||value.meta.assignee.type==='user')
    &&(value.meta.assignee_type==null||value.meta.assignee_type==='User')
    &&(value.meta.assignee?.type==='user'||value.meta.assignee_type==='User');
  if(value.status!=='open'||(target.teamId!==null?
    value.meta.team?.id!==target.teamId||value.meta.assignee!==null||value.meta.assignee_type!=null:
    value.meta.assignee?.id!==target.agentId||!human||value.meta.team!==null))throw new NativeHandoffError('HANDOFF_REMOTE_RESULT_UNCONFIRMED');
}
function policy(op:HandoffOperation,catalog:AttendanceCatalog) {
  const s=op.snapshot!;
  if(!catalog.scope||Object.entries(s.scope).some(([key,value])=>catalog.scope[key as keyof AttendanceScope]!==value)||catalog.credentialRevision!==s.credentialRevision)
    throw new NativeHandoffError('HANDOFF_CONTEXT_CHANGED');
  if(catalog.inboxPolicy?.greetingEnabled!==false||catalog.inboxPolicy?.autoAssignmentEnabled!==false||
    catalog.capabilities?.agentBot!=='SUPPORTED'||catalog.remoteBot!==null||
    s.target.teamId!==null&&!catalog.teams.some(team=>team.id===s.target.teamId&&team.autoAssignment===false)||
    s.target.agentId!==null&&!catalog.agents.some(agent=>agent.id===s.target.agentId&&agent.inboxMember))
    throw new NativeHandoffError('HANDOFF_INBOX_POLICY_UNSAFE');
}

/** Network never runs under a database lock. Stock Chatwoot has no compare-and-set
 * assignment API: preflight/readback detect races but cannot eliminate the final
 * GET/POST race. Local takeover always prevents subsequent remote mutations. */
export function createNativeHandoffService(options:Options) {
  const repository=options.repository??createPostgresHandoffRepository();
  const guard=(op:HandoffOperation,lease=true,settlement=false)=>options.transact(op.organizationId,t=>repository.guard(t,op,lease,settlement));
  const fail=(op:HandoffOperation,error:string,uncertain:boolean)=>options.transact(op.organizationId,t=>repository.fail(t,op,error,uncertain));
  async function canonical(op:HandoffOperation,lease:boolean,settlement=false) {
    const account=await guard(op,lease,settlement),s=op.snapshot!;
    const value=await options.client(account).attendanceConversation(s.scope.accountId,s.remoteConversationId);
    await guard(op,lease,settlement);return value;
  }
  return {
    async dispatch(item:OutboxRow):Promise<OutboxDispatchResult> {
      const prepared=await options.transact(item.organizationId,t=>repository.prepare(t,item));
      if('result' in prepared)return prepared.result;
      let op=prepared.operation;
      if(op.organizationId!==item.organizationId)throw new NativeHandoffError('HANDOFF_SCOPE_MISMATCH');
      if(op.state==='APPLIED')return {kind:'SENT',remoteReference:`chatwoot-handoff:${op.id}`};
      if(op.state==='ACTION_REQUIRED')return {kind:'FAILED',error:op.error??'HANDOFF_ACTION_REQUIRED'};
      if(!prepared.fresh||!op.snapshot)throw new NativeHandoffError('HANDOFF_RECONCILIATION_REQUIRED');
      let dispatched=false;
      try {
        const s=op.snapshot;
        const validated=await options.attendanceService.validateTarget(s.scope,s.target);
        if(validated.credentialRevision!==s.credentialRevision)throw new NativeHandoffError('HANDOFF_CONTEXT_CHANGED');
        policy(op,await options.attendanceService.catalog(op.organizationId,s.scope.integrationId));
        unassigned(op,await canonical(op,true),true);
        let account=await options.transact(op.organizationId,async t=>{
          const account=await repository.guard(t,op,true);op=await repository.stage(t,op,'OPEN_DISPATCHED');return account;
        });
        dispatched=true;
        await options.client(account).handoffFlowConversation(s.scope.accountId,s.remoteConversationId);
        unassigned(op,await canonical(op,true),false);
        op=await options.transact(op.organizationId,t=>repository.stage(t,op,'OPENED'));
        // Recheck policy and the canonical conversation immediately before the
        // final assignment. There are no more remote mutations after assignment.
        policy(op,await options.attendanceService.catalog(op.organizationId,s.scope.integrationId));
        unassigned(op,await canonical(op,true),false);
        account=await options.transact(op.organizationId,async t=>{
          const account=await repository.guard(t,op,true);op=await repository.stage(t,op,'ASSIGNMENT_DISPATCHED');return account;
        });
        await options.client(account).assignAttendanceConversation(s.scope.accountId,s.remoteConversationId,s.target);
        confirmed(op,await canonical(op,true,true));
        await options.transact(op.organizationId,t=>repository.confirm(t,op));
        return {kind:'SENT',remoteReference:`chatwoot-handoff:${op.id}`};
      } catch(error) {
        await fail(op,errorCode(error),dispatched);
        if(dispatched)throw new NativeHandoffError('HANDOFF_REMOTE_OUTCOME_UNKNOWN');
        return {kind:'FAILED',error:errorCode(error)};
      }
    },
    async reconcileOnce(org:string):Promise<{processed:boolean;id?:string;state?:string}> {
      const op=await options.transact(org,t=>repository.next(t,org));if(!op)return {processed:false};
      if(op.organizationId!==org)throw new NativeHandoffError('HANDOFF_SCOPE_MISMATCH');
      if(!op.snapshot||op.phase==='PREPARED') {
        await fail(op,'HANDOFF_INTERRUPTED_BEFORE_REMOTE_WRITE',false);return {processed:true,id:op.id,state:'ACTION_REQUIRED'};
      }
      try {
        // Reads only. An UNKNOWN open/assignment is never automatically replayed,
        // nor does observing one phase authorize the next phase after a restart.
        const value=await canonical(op,false,true);
        confirmed(op,value);
        await options.transact(org,t=>repository.confirm(t,op,'CANONICAL_RECONCILIATION'));return {processed:true,id:op.id,state:'APPLIED'};
      } catch(error) {
        await fail(op,errorCode(error),true);return {processed:true,id:op.id,state:'UNKNOWN'};
      }
    },
  };
}
