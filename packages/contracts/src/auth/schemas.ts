import { z } from 'zod';

const NormalizedEmailSchema = z.string().trim().toLowerCase().email().max(320);

export const OrganizationRoleSchema = z.enum(['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER']);

export const LoginRequestSchema = z.object({
  email: NormalizedEmailSchema,
  password: z.string().min(1).max(1024),
}).strict();

export const OrganizationSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100),
  role: OrganizationRoleSchema,
}).strict();

export const LoginOrganizationsSchema = z.object({
  organizations: z.array(OrganizationSummarySchema),
  selectionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const SelectOrganizationRequestSchema = z.object({
  selectionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  organizationId: z.string().uuid(),
}).strict();

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const AuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(32),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
}).strict();

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>;
export type LoginOrganizations = z.infer<typeof LoginOrganizationsSchema>;
export type SelectOrganizationRequest = z.infer<typeof SelectOrganizationRequestSchema>;
export type AuthTokens = z.infer<typeof AuthTokensSchema>;
