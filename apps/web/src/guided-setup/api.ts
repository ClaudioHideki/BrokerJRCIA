import { z } from 'zod';
import { AutomationPackageRequirementSchema, AutomationPackageSchema, GuidedSetupSchema, type GuidedSetup } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';

export const PackageRecordSchema = z.object({ id: z.uuid(), organizationId: z.uuid(), revision: z.int().positive(),
  rootKey: z.string().min(1).max(100), rootId: z.uuid(), state: z.enum(['DRAFT', 'PUBLISHING', 'UNKNOWN', 'PUBLISHED']),
  flows: z.array(z.object({ key: z.string().max(100), id: z.uuid(), name: z.string().max(120) })).max(32),
  requirements: z.array(AutomationPackageRequirementSchema).max(5000),
  publications: z.record(z.string(), z.object({ version: z.int().positive(), checksum: z.string(), draftRevision: z.int().positive() })),
});
export type PackageRecord = z.infer<typeof PackageRecordSchema>;
export function parseSetup(org: string, value: unknown): GuidedSetup {
  const parsed = GuidedSetupSchema.safeParse(value);
  if (!parsed.success || parsed.data.organizationId !== org) throw new ApiClientError('A configuração não corresponde à empresa atual. Atualize a página.', 409);
  return parsed.data;
}
export function parsePackage(org: string, value: unknown): PackageRecord {
  const parsed = PackageRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.organizationId !== org) throw new ApiClientError('O pacote não corresponde à empresa atual.', 409);
  return parsed.data;
}
export async function getSetup(client: ApiClient, org: string, id: string, signal?: AbortSignal) {
  return parseSetup(org, await client.request(`/v1/guided-setups/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) }));
}
export async function setupAction(client: ApiClient, org: string, setup: GuidedSetup, action: string, input: Record<string, unknown> = {}) {
  const value = await client.request(`/v1/guided-setups/${setup.id}/${action}`, { method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ revision: setup.revision, ...input }) });
  return parseSetup(org, value);
}
export { AutomationPackageSchema };
