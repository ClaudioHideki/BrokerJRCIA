import { z } from 'zod';
const sha256=z.string().regex(/^[0-9a-f]{64}$/);
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id=z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const original={accountId:positive,inboxId:positive,conversationId:positive,messageId:positive};
const direct={instanceId:id,key:id,remoteJid:z.string().regex(/^[1-9][0-9]{1,24}@lid$/).optional(),peer:z.string().regex(/^[1-9][0-9]{7,14}@s\.whatsapp\.net$/),fromMe:z.literal(true)};
export const proofSchema=z.strictObject({
  protocol:z.literal('DIRECT_EVOLUTION_RECEIPT_V1'),organizationId:z.uuid(),integrationId:z.uuid(),channelId:z.uuid(),jobId:z.uuid(),
  origin:z.url(),destinationRevision:positive,credentialRevision:positive,
  rails:z.strictObject({...original,obligationId:z.uuid(),intentId:z.uuid().nullable(),sourceId:z.string().max(170),bodySha256:sha256,attachmentCount:z.literal(0),humanPublic:z.literal(true)}),
  historicalBinding:z.strictObject({instanceId:id,generation:id,evidenceSha256:sha256}),
  evolution:z.strictObject({...original,...direct,rowId:id,bodySha256:sha256,partCount:z.literal(1),matchingRows:z.literal(1)}),
  ack:z.strictObject({...direct,messageRowId:id,rowId:id,status:z.enum(['DELIVERY_ACK','READ'])})
});
