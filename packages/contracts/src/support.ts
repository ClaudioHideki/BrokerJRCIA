import { z } from 'zod';

export const SupportStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED']);
export type SupportStatus = z.infer<typeof SupportStatusSchema>;
export const SupportListQuerySchema = z.strictObject({cursor:z.string().min(1).max(1024).optional(),status:SupportStatusSchema.optional(),company:z.string().trim().min(1).max(160).optional(),assignee:z.union([z.uuid(),z.literal('me'),z.literal('unassigned')]).optional()});
export type SupportListQuery = z.infer<typeof SupportListQuerySchema>;
const text = z.string().trim().min(1).max(10000);
export const CreateSupportTicketSchema = z.strictObject({ title: z.string().trim().min(5).max(160), message: text, requestId: z.uuid() });
export const ReplySupportTicketSchema = z.strictObject({ message: text, revision: z.number().int().positive(), requestId: z.uuid() });
export const UpdateSupportTicketSchema = z.strictObject({ status: SupportStatusSchema, revision: z.number().int().positive(), assignToMe: z.boolean().optional() });
export const SupportTicketSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), organizationName: z.string(), title: z.string(), status: SupportStatusSchema,
  revision: z.number().int().positive(), assigneeId: z.uuid().nullable(), createdAt: z.string(), updatedAt: z.string(),
  firstResponseAt: z.string().nullable(), responseDueAt: z.string(), firstResponseState:z.enum(['PENDING','OVERDUE','MET','LATE']), resolvedAt: z.string().nullable(),
});
export const SupportMessageSchema = z.object({
  id: z.uuid(), authorKind: z.enum(['TENANT', 'PLATFORM']), kind: z.enum(['REPLY', 'EVENT']), body: z.string(), createdAt: z.string(),
});
export const SupportTicketDetailSchema = z.object({ ticket: SupportTicketSchema, messages: z.array(SupportMessageSchema), olderMessagesAvailable: z.boolean() });
export const SupportTicketListSchema = z.object({ data: z.array(SupportTicketSchema), nextCursor: z.string().optional() });
export type SupportTicket = z.infer<typeof SupportTicketSchema>;
export type SupportMessage = z.infer<typeof SupportMessageSchema>;
export type SupportTicketDetail = z.infer<typeof SupportTicketDetailSchema>;
export type SupportTicketList = z.infer<typeof SupportTicketListSchema>;
