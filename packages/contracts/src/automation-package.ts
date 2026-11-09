import { z } from 'zod';
import { AutomationGraphV1Schema } from './automations-v1.js';
import { SUBFLOW_MAX_VERSIONS } from './automation-subflow.js';

export const AUTOMATION_PACKAGE_FORMAT = 'jrc-broker-package/1' as const;
export const AUTOMATION_PACKAGE_MAX_BYTES = 2 * 1024 * 1024;
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u);
/** Keys name versions inside this file, never resources belonging to a tenant. */
export const AutomationPackageSchema = z.strictObject({
  format: z.literal(AUTOMATION_PACKAGE_FORMAT), rootKey: key,
  flows: z.array(z.strictObject({ key, name: z.string().trim().min(1).max(120), graph: AutomationGraphV1Schema }))
    .min(1).max(SUBFLOW_MAX_VERSIONS),
}).superRefine((value, context) => {
  const keys = new Set(value.flows.map(flow => flow.key));
  if (keys.size !== value.flows.length) context.addIssue({ code: 'custom', path: ['flows'], message: 'AUTOMATION_PACKAGE_DUPLICATE_KEY' });
  if (!keys.has(value.rootKey)) context.addIssue({ code: 'custom', path: ['rootKey'], message: 'AUTOMATION_PACKAGE_ROOT_MISSING' });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > AUTOMATION_PACKAGE_MAX_BYTES)
    context.addIssue({ code: 'custom', message: 'AUTOMATION_PACKAGE_SIZE_LIMIT' });
});
export const AutomationPackageRequirementSchema = z.strictObject({
  flowKey: key, nodeId: z.string().min(1).max(100),
  kind: z.enum(['CREDENTIAL', 'HANDOFF', 'CHANNEL', 'RESOURCE', 'MEDIA', 'DOMAIN']),
  fields: z.array(z.string().min(1).max(100)).min(1).max(10),
});
export type AutomationPackage = z.infer<typeof AutomationPackageSchema>;
export type AutomationPackageRequirement = z.infer<typeof AutomationPackageRequirementSchema>;
