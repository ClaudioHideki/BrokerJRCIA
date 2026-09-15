import { z } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const ProblemDetailsSchema = z.object({
  type: z.string().url().default('about:blank'),
  title: z.string().trim().min(1),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  requestId: z.string().uuid().optional(),
}).strict();

z.globalRegistry.add(ProblemDetailsSchema, { id: 'ProblemDetails' });

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
