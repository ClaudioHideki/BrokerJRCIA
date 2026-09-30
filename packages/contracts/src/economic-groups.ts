import { z } from 'zod';

export const CreateEconomicGroupSchema = z.strictObject({ name: z.string().trim().min(1).max(120) });
export const AssignGroupOrganizationsSchema = z.strictObject({
  revision: z.number().int().positive(),
  organizationIds: z.array(z.uuid()).max(200).refine(ids => new Set(ids).size === ids.length, 'Duplicate organization'),
});
export const EconomicGroupSchema = z.strictObject({
  id: z.uuid(), name: z.string(), revision: z.number().int().positive(), organizationIds: z.array(z.uuid()),
});
export const UpdateEconomicGroupSchema = CreateEconomicGroupSchema.extend({ expectedRevision: z.number().int().positive() });
export const RemoveEconomicGroupSchema = z.strictObject({
  expectedRevision: z.number().int().positive(), detachCompanies: z.boolean(),
});
export const EconomicGroupRemovalPreviewSchema = z.strictObject({
  id: z.uuid(), name: z.string(), revision: z.number().int().positive(),
  organizations: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
});
export const EconomicGroupRemovalResultSchema = z.strictObject({ removed: z.literal(true), preservedOrganizationIds: z.array(z.uuid()) });
