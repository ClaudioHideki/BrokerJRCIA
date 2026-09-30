import { z } from 'zod';
import { DeletionPreviewSchema, DeletionStatusSchema } from './lifecycle.js';

const reason = z.string().trim().min(5).max(500);
const companyIds = z.array(z.uuid()).min(1).max(200).refine(ids=>new Set(ids).size===ids.length,'Duplicate company');
export const PreviewGroupCompanyRemovalSchema = z.strictObject({groupId:z.uuid(),reason});
export const GroupCompanyRemovalPreviewSchema = z.strictObject({
  previewId:z.uuid(),previewRevision:z.uuid(),groupId:z.uuid(),groupName:z.string(),groupRevision:z.number().int().positive(),
  expiresAt:z.iso.datetime({offset:true}),companies:z.array(DeletionPreviewSchema),
});
export const RequestGroupCompanyRemovalSchema = z.strictObject({
  groupId:z.uuid(),expectedRevision:z.number().int().positive(),previewId:z.uuid(),previewRevision:z.uuid(),
  selectedCompanyIds:companyIds,confirmation:z.strictObject({
    companies:z.array(z.strictObject({id:z.uuid(),typedName:z.string().min(1).max(120)})).min(1).max(200),
    removeGroupIfEmpty:z.boolean(),
  }),reason,idempotencyKey:z.uuid(),
}).superRefine((value,context)=>{
  const ids=value.confirmation.companies.map(c=>c.id);
  if(new Set(ids).size!==ids.length||ids.length!==value.selectedCompanyIds.length||ids.some(id=>!value.selectedCompanyIds.includes(id)))
    context.addIssue({code:'custom',path:['confirmation','companies'],message:'Confirm exactly the selected companies'});
});
export const GroupCompanyRemovalSchema=z.strictObject({
  operationId:z.uuid(),groupId:z.uuid(),status:z.enum(['RUNNING','PARTIAL','ACTION_REQUIRED','COMPLETED']),
  groupStage:z.enum(['NOT_REQUESTED','PENDING','REMOVED','ALREADY_REMOVED','PRESERVED']),errorCode:z.string().nullable(),
  updatedAt:z.iso.datetime({offset:true}),companies:z.array(z.strictObject({
    id:z.uuid(),name:z.string().nullable(),operationId:z.uuid(),status:DeletionStatusSchema.shape.status,errorCode:z.string().nullable(),
  })),
});
export type RequestGroupCompanyRemoval=z.infer<typeof RequestGroupCompanyRemovalSchema>;
export type GroupCompanyRemoval=z.infer<typeof GroupCompanyRemovalSchema>;
export const GroupCompanyRemovalListSchema=z.strictObject({data:z.array(GroupCompanyRemovalSchema),nextCursor:z.uuid().nullable()});
