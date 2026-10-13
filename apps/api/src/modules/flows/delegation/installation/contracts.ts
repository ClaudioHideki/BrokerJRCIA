import {createHash} from 'node:crypto';
import {z} from 'zod';
import {RegistrationTargetSchema} from '../registration/core.js';

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const InstallationIssueSchema=z.strictObject({registrationId:z.uuid(),expectedRegistrationRevision:positive,expectedCredentialRevision:positive,expectedDestinationRevision:positive,expectedAccountCredentialVersion:positive});
export const InstallationRevokeSchema=z.strictObject({expectedGeneration:positive,operationNonce:z.uuid()});

// Each operation has its own authority. Browser-supplied tenant, origin and
// actor fields are rejected rather than used as a source of authority.
export const InstallationClaimSchema = z.strictObject({
  transferNonce: opaque, operationNonce: z.uuid(), installationCallbackCredential: opaque,
});
export const InstallationRenewSchema = z.strictObject({
  operationNonce: z.uuid(), expectedGeneration: positive,
  expectedCredentialId: z.uuid(), expectedCredentialRevision: positive,
  nativeCallbackCredential: opaque,
});
export const InstallationProofSchema = z.strictObject({
  audience: z.enum(['FLOW_INSTALLATION_CLAIM', 'FLOW_INSTALLATION_RENEW']),
  grantId: z.uuid(), operationNonce: z.uuid(), proofNonce: z.uuid(), expectedGeneration: positive,
  registrationId: z.uuid(), registrationRevision: positive,
  credentialId: z.uuid(), credentialRevision: positive,
  destinationRevision: positive, accountCredentialVersion: positive,
  accountId: positive, tupleDigest: digest,
});

const target = RegistrationTargetSchema.refine(value => value.transport === 'CENTRAL_TRANSPORT' ? value.provider === null : value.provider !== null,
  'Provider must match the approved transport');
const tuple = z.strictObject({
  accountId: positive, destinationRevision: positive, accountCredentialVersion: positive,
  targets: z.array(target).min(1).max(100)
    .refine(values => new Set(values.map(value => value.integrationId)).size === values.length, 'Duplicate integration')
    .refine(values => new Set(values.map(value => value.inboxId)).size === values.length, 'Duplicate Inbox'),
});

export function installationTupleDigest(input: unknown): string {
  const parsed = tuple.parse(input);
  const canonical = {
    accountId: parsed.accountId, destinationRevision: parsed.destinationRevision,
    accountCredentialVersion: parsed.accountCredentialVersion,
    targets: [...parsed.targets].sort((a, b) => a.integrationId < b.integrationId ? -1 : a.integrationId > b.integrationId ? 1 : 0)
      .map(value => ({integrationId: value.integrationId, channelId: value.channelId,
        inboxId: value.inboxId, transport: value.transport, provider: value.provider})),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
