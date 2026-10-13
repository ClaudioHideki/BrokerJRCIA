import { z } from 'zod';

export const DestinationRequestSchema = z.strictObject({
  baseUrl: z.string().min(1).max(2048),
  mode: z.enum(['MANAGED', 'EXTERNAL']),
});
export const FlowOriginStatusSchema=z.strictObject({kind:z.enum(['STOCK','JRC_NATIVE']).nullable(),revision:z.number().int().nonnegative(),status:z.enum(['READY','DECLARATION_REQUIRED','NATIVE_EVIDENCE_REQUIRED','REVOKED']).default('READY')});
export const ChatwootDestinationSchema = z.object({
  organizationId: z.uuid(),
  baseUrl: z.string(),
  mode: z.enum(['MANAGED', 'EXTERNAL']),
  approvalStatus: z.enum(['PENDING', 'APPROVED', 'REVOKED']),
  mediaOrigins: z.array(z.string()),
  flowExecutor:FlowOriginStatusSchema.optional(),
  revision: z.number().int().positive(),
});
export const ApproveDestinationSchema = z.strictObject({
  revision: z.number().int().positive(),
  mediaOrigins: z.array(z.string().max(2048)).max(20).default([]),
  flowExecutor:z.strictObject({kind:z.literal('STOCK'),expectedOriginRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).optional(),
});
export type ChatwootDestination = z.infer<typeof ChatwootDestinationSchema>;
