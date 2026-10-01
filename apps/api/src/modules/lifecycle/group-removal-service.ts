import { z } from 'zod';
import { GroupCompanyRemovalListSchema, GroupCompanyRemovalPreviewSchema, GroupCompanyRemovalSchema, PreviewGroupCompanyRemovalSchema, RequestGroupCompanyRemovalSchema } from '@jrc/contracts';
import { LifecycleError, type LifecycleTransaction } from './service.js';
import { groupRemovalRepository } from './group-removal-repository.js';

export function createGroupRemovalService({transact}:{transact:LifecycleTransaction}) {
  async function run<T>(work:()=>Promise<T>):Promise<T>{
    try{return await work();}catch(error){
      if(error instanceof LifecycleError)throw error;
      if(error instanceof z.ZodError)throw new LifecycleError('GROUP_REMOVAL_INVALID_REQUEST',400);
      const value=error as {code?:string;constraint?:string};
      if(value.code==='42501')throw new LifecycleError('GROUP_REMOVAL_FORBIDDEN',403);
      if(value.code==='P0002')throw new LifecycleError('GROUP_REMOVAL_NOT_FOUND',404);
      const conflicts:Record<string,string>={group_removal_preview_changed:'GROUP_REMOVAL_PREVIEW_CHANGED',
        group_removal_idempotency:'GROUP_REMOVAL_IDEMPOTENCY_CONFLICT',group_removal_confirmation:'GROUP_REMOVAL_CONFIRMATION_REQUIRED',
        group_removal_pending:'GROUP_REMOVAL_COMPANY_BLOCKED',group_removal_busy:'GROUP_REMOVAL_COMPANY_ALREADY_REQUESTED',
        lifecycle_pending_work:'LIFECYCLE_PENDING_WORK',lifecycle_conflict:'LIFECYCLE_CONFLICT'};
      if(value.constraint&&conflicts[value.constraint])throw new LifecycleError(conflicts[value.constraint]!,value.constraint==='group_removal_confirmation'?400:409);
      throw new LifecycleError('GROUP_REMOVAL_UNAVAILABLE',503);
    }
  }
  return {
    preview:(actor:string,input:unknown)=>run(async()=>{
      const value=PreviewGroupCompanyRemovalSchema.parse(input);z.uuid().parse(actor);
      return transact(async tx=>GroupCompanyRemovalPreviewSchema.parse(await groupRemovalRepository(tx).preview(actor,value.groupId,value.reason)));
    }),
    request:(actor:string,input:unknown)=>run(async()=>{
      const value=RequestGroupCompanyRemovalSchema.parse(input);z.uuid().parse(actor);
      return transact(async tx=>GroupCompanyRemovalSchema.parse(await groupRemovalRepository(tx).request(actor,value)));
    }),
    get:(actor:string,id:string)=>run(async()=>{
      z.uuid().parse(actor);z.uuid().parse(id);
      return transact(async tx=>GroupCompanyRemovalSchema.parse(await groupRemovalRepository(tx).get(actor,id)));
    }),
    list:(actor:string,groupId:string,cursor?:string)=>run(async()=>{
      z.uuid().parse(actor);z.uuid().parse(groupId);if(cursor)z.uuid().parse(cursor);
      return transact(async tx=>GroupCompanyRemovalListSchema.parse(await groupRemovalRepository(tx).list(actor,groupId,cursor)));
    }),
    processOne:()=>run(()=>transact(tx=>groupRemovalRepository(tx).processOne())),
  };
}
export type GroupRemovalService=ReturnType<typeof createGroupRemovalService>;
