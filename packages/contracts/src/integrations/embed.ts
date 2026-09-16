import { z } from 'zod';

export const EmbedChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const EmbedVerifierSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
export const EmbedStartSchema = z.strictObject({ embedId: z.uuid(), challenge: EmbedChallengeSchema });
export const EmbedExchangeSchema = z.strictObject({ verifier: EmbedVerifierSchema });
export const EmbedApproveSchema = z.strictObject({ integrationIds: z.array(z.uuid()).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length, 'Duplicate integration') });
export const EmbedAppSchema = z.strictObject({ embedId: z.uuid() });
export const EmbedAppSetupSchema = EmbedAppSchema.extend({ title: z.string(), url: z.url(),
  state: z.enum(['UNCONFIGURED', 'INSTALLED', 'MANUAL', 'UNKNOWN']), remoteAppId: z.number().int().positive().nullable() });
export const EmbedPolicySchema = z.strictObject({ origin: z.url() });
export const EmbedStartedSchema = z.strictObject({ requestId: z.uuid(), expiresAt: z.iso.datetime() });
export const EmbedConnectionSchema = z.strictObject({ integrationId: z.uuid(), inboxId: z.number().int().positive(), name: z.string(), canPair: z.boolean() });
export const EmbedApprovalViewSchema = EmbedStartedSchema.extend({ accountId: z.number().int().positive(), chatwootOrigin: z.url(),
  connections: z.array(EmbedConnectionSchema).max(100) });
export const EmbedExchangeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('PENDING') }),
  z.strictObject({ status: z.literal('AUTHORIZED'), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.iso.datetime(),
    accountId: z.number().int().positive(), connections: z.array(EmbedConnectionSchema).max(100) }),
]);
export type EmbedConnection = z.infer<typeof EmbedConnectionSchema>;
export type EmbedExchangeResult = z.infer<typeof EmbedExchangeResultSchema>;

const diagnosticStatuses = new Set(['PENDING', 'AUTHORIZED', 'DENIED', 'EXPIRED', 'UNAVAILABLE', 'IDLE', 'WAITING', 'STARTING']);
const diagnosticCodes = new Set(['EMBED_AUTHORIZATION_DENIED', 'EMBED_UNAVAILABLE', 'CHATWOOT_EMBED_DISABLED', 'INVALID_REQUEST',
  'EMBED_RATE_LIMITED', 'EMBED_INSTALL_UNAVAILABLE', 'EMBED_INSTALL_IN_PROGRESS', 'EMBED_INSTALL_CONTEXT_CHANGED', 'CHATWOOT_CONTROL_FORBIDDEN']);
/** Whitelist diagnostics; callers must never supply request/response bodies or pairing material. */
export function sanitizeEmbedDiagnostic(value: unknown): { requestId?: string; status?: string | number; code?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const field = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
  const requestId = field('requestId'), status = field('status'), code = field('code');
  return {
    ...(typeof requestId === 'string' && z.uuid().safeParse(requestId).success ? { requestId } : {}),
    ...((typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) || (typeof status === 'string' && diagnosticStatuses.has(status)) ? { status: status as string | number } : {}),
    ...(typeof code === 'string' && diagnosticCodes.has(code) ? { code } : {}),
  };
}
