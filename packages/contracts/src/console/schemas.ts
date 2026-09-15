import { z } from 'zod';

import { OrganizationSummarySchema } from '../auth/schemas.js';
import { ProblemDetailsSchema } from '../problems.js';

export const CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE = 'ORGANIZATION_SWITCH_REJECTED';

export const ConsoleOrganizationSwitchRejectedProblemSchema = ProblemDetailsSchema.extend({
  status: z.literal(409),
  code: z.literal(CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE),
}).strict();

z.globalRegistry.add(ConsoleOrganizationSwitchRejectedProblemSchema, {
  id: 'ConsoleOrganizationSwitchRejectedProblem',
});

export const ConsoleUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(320),
}).strict();

export const ConsoleSelectOrganizationRequestSchema = z.object({
  selectionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  organizationId: z.string().uuid(),
}).strict();

export const ConsoleSwitchOrganizationRequestSchema = z.object({
  organizationId: z.string().uuid(),
}).strict();

export const ConsoleSessionResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  user: ConsoleUserSchema,
  activeOrganization: OrganizationSummarySchema,
  organizations: z.array(OrganizationSummarySchema),
}).strict();

export type ConsoleUser = z.infer<typeof ConsoleUserSchema>;
export type ConsoleSelectOrganizationRequest = z.infer<
  typeof ConsoleSelectOrganizationRequestSchema
>;
export type ConsoleSwitchOrganizationRequest = z.infer<
  typeof ConsoleSwitchOrganizationRequestSchema
>;
export type ConsoleSessionResponse = z.infer<typeof ConsoleSessionResponseSchema>;
