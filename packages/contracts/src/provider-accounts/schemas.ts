import { z } from 'zod';

import { ProviderKindSchema } from '../instances/schemas.js';
import { createPageSchema, CursorPaginationQuerySchema } from '../pagination.js';

export const ProviderAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  provider: ProviderKindSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const ProviderAccountPageSchema = createPageSchema(ProviderAccountSchema);
export const ListProviderAccountsQuerySchema = CursorPaginationQuerySchema.extend({
  provider: ProviderKindSchema.optional(),
}).strict();

export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;
