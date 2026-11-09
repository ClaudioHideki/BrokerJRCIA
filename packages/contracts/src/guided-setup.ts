import { z } from 'zod';
import { humanTargetSchema } from './attendance-v1.js';

const revision = z.int().positive(), id = z.uuid();
export const SetupSelectionSchema = z.strictObject({
  transport: z.enum(['QR', 'META']), channelId: id.optional(), integrationId: id.optional(),
  automationId: id.optional(), version: revision.optional(), packageId: id.optional(),
  agentIds: z.array(z.int().positive()).max(1000).refine(values => new Set(values).size === values.length).optional(),
  humanTarget: humanTargetSchema.refine(target => (target.agentId === null) !== (target.teamId === null)).optional(),
});
export const GuidedSetupStartSchema = z.strictObject({ name: z.string().trim().min(1).max(120), transport: z.enum(['QR', 'META']) });
export const GuidedSetupUpdateSchema = z.strictObject({ revision, selection: SetupSelectionSchema });
export const GuidedSetupRevisionSchema = z.strictObject({ revision });
export const SetupCheckSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/u), title: z.string().min(1).max(300),
  state: z.enum(['PASS', 'ACTION_REQUIRED', 'UNVERIFIED']), actionHref: z.string().regex(/^\/[A-Za-z0-9/?&=._%-]*$/u).optional(),
});
export const SetupReadinessSchema = z.strictObject({
  checkedAt: z.iso.datetime(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  owner: z.strictObject({ revision: z.int().nonnegative(), automationId: id.nullable(), version: revision.nullable(),
    executor: z.enum(['BROKER', 'EXTERNAL', 'NONE']).optional() }),
  readyForTest: z.boolean(), checks: z.array(SetupCheckSchema).max(100),
});
export const SetupProofSchema = z.strictObject({
  source: z.literal('NATIVE_RUNTIME'), executionId: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  provider: z.enum(['QR', 'META']), collectedAt: z.iso.datetime(), passed: z.boolean(), checks: z.array(SetupCheckSchema).max(20),
});
export const GuidedSetupSchema = z.strictObject({
  id, organizationId: id, actorId: id, name: z.string().min(1).max(120), revision,
  state: z.enum(['EDITING', 'REVIEW', 'TESTING', 'ACTIVE', 'UNKNOWN', 'CANCELLED']), selection: SetupSelectionSchema,
  readiness: SetupReadinessSchema.nullable(), proof: SetupProofSchema.nullable(),
  pendingAction: z.enum(['TEST', 'ACTIVATE', 'DEACTIVATE']).nullable().optional(),
  test: z.strictObject({ keyword: z.string().min(1).max(100), startedAt: z.iso.datetime(),
    automationId: id.nullable(), version: revision.nullable() }).nullable().optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type SetupSelection = z.infer<typeof SetupSelectionSchema>;
export type GuidedSetup = z.infer<typeof GuidedSetupSchema>;
export type SetupReadiness = z.infer<typeof SetupReadinessSchema>;
export type SetupProof = z.infer<typeof SetupProofSchema>;
export type SetupCheck = z.infer<typeof SetupCheckSchema>;
