import { z } from 'zod';
import { humanTargetSchema } from './attendance-v1.js';
import { AutomationLocalHandoffConfigV2Schema } from './attendance-destination-v2.js';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const remoteId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** References observed in the authorized catalog. The server must resolve and revalidate them. */
export const AutomationHandoffConfigV1Schema = z.strictObject({
  handoffVersion: z.literal(1),
  destination: z.strictObject({
    integrationId: z.uuid(), destinationRevision: revision,
    accountId: remoteId, inboxId: remoteId, credentialRevision: revision,
  }),
  // Chatwoot ignores team_id when assignee_id is present. Select one unambiguous target.
  target: humanTargetSchema.refine(target => (target.teamId === null) !== (target.agentId === null),
    'Selecione somente um time ou um agente.'),
});
export type AutomationHandoffConfigV1 = z.infer<typeof AutomationHandoffConfigV1Schema>;
export const AutomationHandoffConfigSchema=z.union([AutomationHandoffConfigV1Schema,AutomationLocalHandoffConfigV2Schema]);

export function hasNativeHandoffConfig(data: Record<string, unknown>): boolean {
  return ['handoffVersion', 'destination', 'target'].some(key => Object.hasOwn(data, key));
}
/** Keep unversioned historical nodes readable; partial upgrades must never fall back to legacy. */
export const CompatibleAutomationHandoffConfigSchema = z.record(z.string(), z.unknown()).superRefine((data, context) => {
  if (!hasNativeHandoffConfig(data)) return;
  const parsed = (data.handoffVersion===2?AutomationLocalHandoffConfigV2Schema:AutomationHandoffConfigV1Schema).safeParse(data);
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({code:'custom',path:issue.path,message:issue.message});
});
