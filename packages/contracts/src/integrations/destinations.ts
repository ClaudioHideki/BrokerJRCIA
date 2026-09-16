import { z } from 'zod';

export const DestinationRequestSchema = z.strictObject({
  baseUrl: z.string().min(1).max(2048),
  mode: z.enum(['MANAGED', 'EXTERNAL']),
});
export const ChatwootDestinationSchema = z.object({
  organizationId: z.uuid(),
  baseUrl: z.string(),
  mode: z.enum(['MANAGED', 'EXTERNAL']),
  approvalStatus: z.enum(['PENDING', 'APPROVED', 'REVOKED']),
  mediaOrigins: z.array(z.string()),
  revision: z.number().int().positive(),
});
export const ApproveDestinationSchema = z.strictObject({
  revision: z.number().int().positive(),
  mediaOrigins: z.array(z.string().max(2048)).max(20).default([]),
});
export type ChatwootDestination = z.infer<typeof ChatwootDestinationSchema>;
