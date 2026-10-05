import type { AttendanceScope, HumanTarget } from '@jrc/contracts';
import type { OrganizationTransaction, TenantTransaction } from '../../db/tenant-transaction.js';
import type { OutboxRow } from '../automations/repository.js';
import type { OutboxDispatchResult } from '../automations/service.js';
import type { AccountRow } from '../integrations/chatwoot-context.js';

export type HandoffPhase='PREPARED'|'OPEN_DISPATCHED'|'OPENED'|'ASSIGNMENT_DISPATCHED'|'CONFIRMED';
export type HandoffState='PENDING'|'APPLIED'|'UNKNOWN'|'ACTION_REQUIRED';
export interface HandoffSnapshot {
  scope:AttendanceScope; origin:string; credentialRevision:number; bindingId:string; bindingRevision:number;
  automationId:string; version:number; ownerRevision:number; controlRevision:number;
  sessionId:string; sessionRevision:number; cycle:number; remoteConversationId:number; target:HumanTarget;
}
export interface HandoffOperation {
  id:string; organizationId:string; outboxId:string; executionId:string; channelId:string; conversationId:string;
  leaseToken:string; snapshot:HandoffSnapshot|null; phase:HandoffPhase; state:HandoffState; error:string|null;
}
export type HandoffPreparation={operation:HandoffOperation;fresh:boolean}|{result:OutboxDispatchResult};
export interface HandoffRepository {
  prepare(tx:TenantTransaction,item:OutboxRow):Promise<HandoffPreparation>;
  guard(tx:TenantTransaction,operation:HandoffOperation,requireLease:boolean,settlement?:boolean):Promise<AccountRow>;
  stage(tx:TenantTransaction,operation:HandoffOperation,phase:HandoffPhase):Promise<HandoffOperation>;
  fail(tx:TenantTransaction,operation:HandoffOperation,error:string,uncertain:boolean):Promise<void>;
  confirm(tx:TenantTransaction,operation:HandoffOperation,evidence?:'DISPATCH_READBACK'|'CANONICAL_RECONCILIATION'):Promise<void>;
  next(tx:TenantTransaction,org:string):Promise<HandoffOperation|null>;
}
export interface HandoffTransactions {transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>}
export class NativeHandoffError extends Error {constructor(readonly code:string){super(code);}}
