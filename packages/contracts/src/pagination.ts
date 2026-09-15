import { z } from 'zod';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const CursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict();

export interface Page<T> {
  data: T[];
  pageInfo: {
    hasNextPage: boolean;
    nextCursor: string | null;
  };
}

export function createPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      nextCursor: z.string().nullable(),
    }).strict(),
  }).strict();
}
