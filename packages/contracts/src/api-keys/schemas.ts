import { z } from 'zod';

import { createPageSchema, CursorPaginationQuerySchema } from '../pagination.js';

export const ApiKeyScopeSchema = z.enum([
  'instances:read',
  'instances:write',
  'api_keys:manage',
]);

export const IssueApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1).max(3),
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
}).strict();

export const ApiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const IssuedApiKeySchema = ApiKeySchema.omit({
  revokedAt: true,
  lastUsedAt: true,
}).extend({
  secret: z.string().regex(/^jrc_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/),
}).strict();

export const ApiKeyPageSchema = createPageSchema(ApiKeySchema);
export const ListApiKeysQuerySchema = CursorPaginationQuerySchema;
export const ApiKeyIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;
export type IssueApiKeyRequest = z.infer<typeof IssueApiKeyRequestSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type IssuedApiKey = z.infer<typeof IssuedApiKeySchema>;
