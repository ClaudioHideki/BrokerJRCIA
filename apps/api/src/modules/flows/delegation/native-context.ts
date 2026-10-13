import {z} from 'zod';
import {FlowScopesSchema} from '@jrc/contracts';
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const NativeContextQuerySchema=z.strictObject({cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(100)});
export const NativeContextResponseSchema=z.strictObject({
 credential:z.strictObject({id:z.uuid(),revision:positive,expiresAt:z.iso.datetime(),scopes:FlowScopesSchema}),
 destination:z.strictObject({organizationId:z.uuid(),origin:z.url(),accountId:positive,destinationRevision:positive,accountCredentialVersion:positive}),
 targets:z.array(z.strictObject({integrationId:z.uuid(),channelId:z.uuid(),accountId:positive,inboxId:positive,transport:z.enum(['BROKER_TRANSPORT','CENTRAL_TRANSPORT']),provider:z.literal('BAILEYS').nullable()})).max(100),
 nextCursor:z.uuid().nullable(),
});
