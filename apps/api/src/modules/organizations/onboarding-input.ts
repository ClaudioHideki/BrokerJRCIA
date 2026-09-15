import { z } from 'zod';

const CanonicalOnboardingInputSchema = z.object({
  organizationName: z.string().trim().min(1).max(200),
  organizationSlug: z.string().trim().toLowerCase().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string()
    .max(1024)
    .refine((value) => value.trim().length > 0)
    .optional(),
  requestId: z.string().uuid(),
}).strict();

export interface CanonicalOnboardingInput {
  organizationName: string;
  organizationSlug: string;
  email: string;
  password?: string;
  requestId: string;
}

export function validateCanonicalOnboardingInput(
  input: CanonicalOnboardingInput,
): CanonicalOnboardingInput | null {
  const result = CanonicalOnboardingInputSchema.safeParse(input);
  if (!result.success) {
    return null;
  }
  const canonicalInput = {
    organizationName: result.data.organizationName,
    organizationSlug: result.data.organizationSlug,
    email: result.data.email,
    requestId: result.data.requestId,
  };
  return result.data.password === undefined
    ? canonicalInput
    : { ...canonicalInput, password: result.data.password };
}
