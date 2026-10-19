import { z } from 'zod';
import { DataVariableKeySchema } from './automation-data-v2.js';
import {DomainCommandConfigSchema} from './automation-domain-command.js';

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const boundedText = (maximum: number) => z.string().refine(value => bytes(value) <= maximum);
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/u).nullable();
const positiveVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ConversationAttributeDefinitionSchema = z.strictObject({
  valueType: z.enum(['string', 'number', 'boolean', 'enum', 'date', 'url']),
  maxLength: z.number().int().min(1).max(4096),
  allowedValues: z.array(z.string().min(1).max(256)).max(100).refine(values => new Set(values).size === values.length),
});
export type ConversationAttributeDefinition = z.infer<typeof ConversationAttributeDefinitionSchema>;
const valueSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('LITERAL'), value: z.union([boundedText(4096), z.number().finite(), z.boolean()]) }),
  z.strictObject({ kind: z.literal('VARIABLE'), variable: DataVariableKeySchema }),
]);
const common = { channelId: z.uuid(), target: DataVariableKeySchema, timeoutMs: z.number().int().min(100).max(30000) };
const resource = { resourceId: z.uuid(), resourceRevision: revision };
function effectSchema<V extends 1 | 2>(version: V) {
  const shared = { ...common, conversationEffectVersion: z.literal(version) };
  return z.discriminatedUnion('operation', [
    z.strictObject({ ...shared, ...resource, operation: z.literal('tag') }),
    z.strictObject({ ...shared, ...resource, operation: z.literal('attribute'), valueSource }),
    z.strictObject({ ...shared, operation: z.literal('note'), text: boundedText(4096).refine(value => Boolean(value.trim())) }),
    z.strictObject({ ...shared, operation: z.literal('resolve'), status: z.literal('RESOLVED') }),
  ]);
}
// Historical data is readable, but only the explicit v2 schema admits the new executor.
export const ConversationEffectConfigV1Schema = effectSchema(1);
export const ConversationEffectConfigSchema = z.union([effectSchema(2),DomainCommandConfigSchema]);
export type ConversationEffectConfig = z.infer<typeof ConversationEffectConfigSchema>;
function mediaSchema<V extends 1 | 2>(version: V) {
  return z.strictObject({ mediaEffectVersion: z.literal(version), ...common, mediaId: z.uuid(),
    mediaRevision: positiveVersion, caption: boundedText(1024) });
}
export const MediaEffectConfigV1Schema = mediaSchema(1);
export const MediaEffectConfigSchema = mediaSchema(2);
export type MediaEffectConfig = z.infer<typeof MediaEffectConfigSchema>;

export function validateConversationAttribute(raw: ConversationAttributeDefinition, value: unknown): string | number | boolean {
  const definition = ConversationAttributeDefinitionSchema.parse(raw);
  let valid = false;
  if (definition.valueType === 'number') valid = typeof value === 'number' && Number.isFinite(value);
  else if (definition.valueType === 'boolean') valid = typeof value === 'boolean';
  else if (typeof value === 'string' && bytes(value) <= definition.maxLength) {
    if (definition.valueType === 'string') valid = true;
    else if (definition.valueType === 'enum') valid = definition.allowedValues.includes(value);
    else if (definition.valueType === 'date') {
      const date = new Date(value + 'T00:00:00Z');
      valid = /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    } else try {
      const url = new URL(value);
      valid = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
    } catch { valid = false; }
  }
  if (!valid) throw Error('AUTOMATION_ATTRIBUTE_VALUE_INVALID');
  return value as string | number | boolean;
}

const capability = z.strictObject({ state: z.enum(['SUPPORTED', 'UNAVAILABLE', 'UNVERIFIED']),
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/u).nullable() })
  .refine(value => value.state === 'SUPPORTED' ? value.reason === null : value.reason !== null);
export const ActionResourceSchema = z.strictObject({ id: z.uuid(), name: z.string().min(1).max(120),
  kind: z.enum(['LABEL', 'ATTRIBUTE']), revision, definition: ConversationAttributeDefinitionSchema.nullable() })
  .refine(value => value.kind === 'ATTRIBUTE' ? value.definition !== null : value.definition === null);
export type ActionResource = z.infer<typeof ActionResourceSchema>;
export const ActionResourceWriteSchema = z.strictObject({
  id: z.uuid().optional(), editRevision: positiveVersion.optional(), name: z.string().trim().min(1).max(120),
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/u), kind: z.enum(['LABEL', 'ATTRIBUTE']),
  definition: ConversationAttributeDefinitionSchema.nullable(), status: z.enum(['ACTIVE', 'REVOKED']),
}).refine(value => (value.kind === 'LABEL') === (value.definition === null), 'A definição deve corresponder ao tipo.')
  .refine(value => (value.id === undefined) === (value.editRevision === undefined), 'Informe a revisão atual.');
export type ActionResourceWrite = z.infer<typeof ActionResourceWriteSchema>;
const scope = z.strictObject({ organizationId: z.uuid(), rootAutomationId: z.uuid(), channelId: z.uuid() });
export const AutomationResourceChannelsSchema = z.strictObject({ schemaVersion: z.literal(1),
  scope: z.strictObject({ organizationId: z.uuid(), rootAutomationId: z.uuid() }),
  data: z.array(z.strictObject({ id: z.uuid(), name: z.string().min(1).max(120) })).max(200), nextCursor: cursor,
}).refine(page => new Set(page.data.map(channel => channel.id)).size === page.data.length);
export type AutomationResourceChannels = z.infer<typeof AutomationResourceChannelsSchema>;
export const ActionCatalogPageSchema = z.strictObject({ schemaVersion: z.literal(1), scope,
  profile: z.enum(['STANDALONE', 'CENTRAL']), capabilities: z.strictObject({
    tag: capability, attribute: capability, note: capability, resolve: capability, media: capability,
    domain: z.object({state:z.enum(['SUPPORTED','UNAVAILABLE','UNVERIFIED']),reason:z.string().nullable(),
      owners:z.array(z.strictObject({id:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),name:z.string().min(1).max(160)})).max(200).default([])})
      .refine(value=>value.state==='SUPPORTED'?value.reason===null:value.reason!==null).optional(),
  }), data: z.array(ActionResourceSchema).max(200), nextCursor: cursor });
export type ActionCatalogPage = z.infer<typeof ActionCatalogPageSchema>;
export const AutomationMediaAssetSchema = z.strictObject({ schemaVersion: z.literal(1), scope, id: z.uuid(),
  revision: positiveVersion, status: z.enum(['STORING', 'READY', 'REVOKED']), name: z.string().min(1).max(120),
  kind: z.enum(['image', 'audio', 'video', 'document']), mimeType: z.string().min(1).max(100),
  byteSize: z.number().int().min(1).max(16777216) });
export type AutomationMediaAsset = z.infer<typeof AutomationMediaAssetSchema>;
export const ActionSimulationResponseSchema = z.strictObject({ type: z.literal('ACTION_RESPONSE'),
  nodeId: z.string().min(1).max(100), waitId: z.uuid(), outcome: z.enum(['success', 'error', 'timeout', 'unknown']) });
export type ActionSimulationResponse = z.infer<typeof ActionSimulationResponseSchema>;
export const ConversationEffectWaitSchema = z.strictObject({ nodeId: z.string().min(1).max(100),
  waitId: z.uuid(), operation: z.enum(['tag', 'attribute', 'note', 'resolve', 'media','domain']) });
export type ConversationEffectWait = z.infer<typeof ConversationEffectWaitSchema>;

export function compatibleConversationEffectSchema(type: string, legacy: z.ZodType): z.ZodType {
  return z.unknown().superRefine((value, context) => {
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const version = type === 'media' ? data.mediaEffectVersion : data.conversationEffectVersion;
    const historical = type === 'media' ? MediaEffectConfigV1Schema : ConversationEffectConfigV1Schema;
    const modern = type === 'media' ? MediaEffectConfigSchema : ConversationEffectConfigSchema;
    const parsed = (version === undefined ? legacy : version === 1 ? historical : modern).safeParse(value);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue, path: issue.path });
    else if (version !== undefined && type !== 'media' && (parsed.data as ConversationEffectConfig).operation !== type) {
      context.addIssue({ code: 'custom', path: ['operation'], message: 'A operação deve corresponder ao bloco.' });
    }
  });
}
export function conversationEffectPorts(data: Record<string, unknown>, type?: string): string[] {
  if (data.conversationEffectVersion === 2 && (data.operation === 'resolve' || type === 'resolve')) return [];
  if (data.conversationEffectVersion === 2 || data.mediaEffectVersion === 2) return ['success', 'error', 'timeout'];
  if (data.conversationEffectVersion === 1 || data.mediaEffectVersion === 1) return ['success', 'error', 'timeout', 'unknown'];
  return ['success', 'error'];
}
