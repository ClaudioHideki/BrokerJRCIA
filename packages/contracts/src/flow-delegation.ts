import { z } from 'zod';
import { AutomationGraphV1Schema } from './automations-v1.js';
import { FLOW_SCOPES, FLOW_GUARDED_PATHS } from './flow-delegation-constants.js';

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const externalId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const integrationIds = z.array(z.uuid()).min(1).max(100).refine(unique, 'Duplicate integration');
export const FlowScopeSchema = z.enum(FLOW_SCOPES);
const scopes = z.array(FlowScopeSchema).min(1).max(4).refine(unique, 'Duplicate scope');
const name = z.string().trim().min(1).max(120);

// No browser authority fields: organization/account/channel are resolved from
// credential + local connection mapping. Session creation is BFF-only.
export const FlowSessionCreateSchema = z.strictObject({
  externalActorId: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/), nonce: z.uuid(), integrationIds, scopes,
});
export const FlowDraftCreateSchema = z.strictObject({ name, graph: AutomationGraphV1Schema, integrationIds });
export const FlowDraftSaveSchema = z.strictObject({
  name, graph: AutomationGraphV1Schema, revision, expectedScopeRevision: revision,
});
export const FlowPublishSchema = z.strictObject({ revision, expectedScopeRevision: revision });
export const FlowBindSchema = z.strictObject({
  integrationId: z.uuid(), cutoverId: z.uuid(), version: revision, expectedScopeRevision: revision,
  expectedOwnerRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

// SERVER-to-SERVER adapter contracts. These schemas are not editor request bodies.
export const FlowIntrospectionRequestSchema = z.strictObject({
  nonce: z.uuid(), externalActorId: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/),
  accountId: externalId, destinationRevision: revision,
  inboxIds: z.array(externalId).min(1).max(100).refine(unique),
});
export const FlowIntrospectionDecisionSchema = FlowIntrospectionRequestSchema.extend({
  accountActive: z.boolean(), member: z.boolean(), featureEnabled: z.boolean(),
  role: z.enum(['administrator', 'agent']).nullable(),
});
export const FlowCutoverProofSchema = z.strictObject({
  cutoverId: z.uuid(), organizationId: z.uuid(), integrationId: z.uuid(), accountId: externalId, inboxId: externalId,
  cutoverRevision: revision, hostFenceRevision: revision,
  expectedOwnerRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  admissionClosed: z.literal(true), liveRuns: z.literal(0), legacyJobs: z.literal(0), uncertainEffects: z.literal(0),
  guardedPaths: z.array(z.enum(FLOW_GUARDED_PATHS)).min(FLOW_GUARDED_PATHS.length).max(FLOW_GUARDED_PATHS.length).refine(unique),
  hostSourceSha: z.string().regex(/^[a-f0-9]{40}$/), hostImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).refine(value => value.cutoverRevision === value.hostFenceRevision, 'Fence must match the cutover epoch');

import {AutomationBindingV1Schema,AutomationDefinitionV1Schema,AutomationPublishedVersionV1Schema} from './automations-v1.js';
import {NodeDiagnosticSchema} from './automation-node-definitions.js';

const rev=z.number().int().positive().max(Number.MAX_SAFE_INTEGER),cas=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const FlowScopesSchema=z.array(z.enum(['flow:read','flow:edit','flow:publish','flow:bind'])).min(1).max(4).refine(values=>new Set(values).size===values.length);
export const FlowTargetsSchema=z.strictObject({data:z.array(z.strictObject({integrationId:z.uuid(),channelId:z.uuid(),accountId:z.number().int().positive(),inboxId:z.number().int().positive(),transport:z.enum(['BROKER_TRANSPORT','CENTRAL_TRANSPORT']),scopes:FlowScopesSchema,ownerRevision:cas,profileRevision:cas})).max(100)});
export const FlowDefinitionScopeSchema=z.strictObject({revision:rev,integrationIds:z.array(z.uuid()).min(1).max(100)});
export const FlowBrokerSessionSchema=z.strictObject({integrationIds:z.array(z.uuid()).min(1).max(100).refine(values=>new Set(values).size===values.length),scopes:FlowScopesSchema});
export const FlowSessionResponseSchema=z.strictObject({id:z.uuid(),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),expiresAt:z.iso.datetime()});
export const FlowProfileInputSchema=z.strictObject({integrationId:z.uuid(),expectedRevision:cas});
export const FlowProfileResponseSchema=z.strictObject({revision:rev,hostKind:z.enum(['STOCK','JRC_NATIVE']),originCapabilityRevision:rev});
export const FlowMemberGrantSchema=z.strictObject({userId:z.uuid(),integrationId:z.uuid(),scopes:FlowScopesSchema.or(z.tuple([])),expectedRevision:cas});
export const FlowDefinitionSchema=AutomationDefinitionV1Schema.safeExtend({scopeRevision:rev});
export const FlowListSchema=z.strictObject({data:z.array(AutomationDefinitionV1Schema).max(100),nextCursor:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).nullable()});
export const FlowVersionsSchema=z.strictObject({data:z.array(AutomationPublishedVersionV1Schema)});
export const FlowValidationSchema=z.strictObject({valid:z.boolean(),diagnostics:z.array(NodeDiagnosticSchema),errors:z.array(z.string())});
export const FlowBindingSchema=AutomationBindingV1Schema.extend({ownerRevision:cas});
export const FlowCutoverPrepareSchema=z.strictObject({expectedOwnerRevision:cas});
export const FlowCutoverReconcileSchema=z.strictObject({cutoverId:z.uuid(),expectedCutoverRevision:rev,expectedOwnerRevision:cas});
export const FlowCutoverResultSchema=z.strictObject({id:z.uuid(),revision:rev,phase:z.enum(['DRAINED','ROLLED_BACK'])});
export const FlowCutoverStatusSchema=z.strictObject({id:z.uuid(),integrationId:z.uuid(),phase:z.enum(['REQUESTED','FENCED','DRAINED','ACTIVATED','UNKNOWN','ROLLED_BACK','ROLLBACK_DRAINING']),revision:rev,expectedOwnerRevision:cas,updatedAt:z.iso.datetime(),proofValidUntil:z.iso.datetime().nullable(),ready:z.boolean()}).nullable();
