import { z } from 'zod';

const quota=z.number().int().min(1).max(100000000);
export const CommercialLimitsSchema=z.strictObject({maxInstances:quota,maxUsers:quota,messagesPerDay:quota,maxPendingMessages:quota});
export const CommercialOverridesSchema=CommercialLimitsSchema.partial().extend({flowsEnabled:z.boolean().optional()});
export const CreateCommercialPlanSchema=z.strictObject({name:z.string().trim().min(1).max(80),limits:CommercialLimitsSchema,flowsEnabled:z.boolean()});
export const CreateCommercialPlanVersionSchema=CreateCommercialPlanSchema.omit({name:true}).extend({expectedRevision:z.number().int().positive()});
export const AssignCommercialPlanSchema=z.strictObject({planVersionId:z.uuid(),overrides:CommercialOverridesSchema,expectedRevision:z.number().int().nonnegative()});
export const CommercialPlanVersionSchema=CreateCommercialPlanSchema.extend({id:z.uuid(),planId:z.uuid(),version:z.number().int().positive()});
export const CommercialPlanCatalogSchema=z.strictObject({data:z.array(CommercialPlanVersionSchema)});
export const CommercialUsageSchema=z.strictObject({connections:z.number().int().nonnegative(),users:z.number().int().nonnegative(),messagesAcceptedToday:z.number().int().nonnegative(),pendingMessages:z.number().int().nonnegative(),storageBytes:z.null(),aiTokens:z.null()});
export const CommercialAssignmentSchema=z.strictObject({organizationId:z.uuid(),revision:z.number().int().nonnegative(),planVersionId:z.uuid().nullable(),name:z.string(),version:z.number().int().positive().nullable(),limits:CommercialLimitsSchema,flowsEnabled:z.boolean(),overrides:CommercialOverridesSchema,usage:CommercialUsageSchema});
export type CommercialPlanVersion=z.infer<typeof CommercialPlanVersionSchema>;
export type CommercialAssignment=z.infer<typeof CommercialAssignmentSchema>;
export type CommercialOverrides=z.infer<typeof CommercialOverridesSchema>;
