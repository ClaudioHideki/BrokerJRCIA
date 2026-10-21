import { z } from 'zod';
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const CampaignTransportSchema = z.strictObject({
  protocol:z.literal('chatwoot-campaigns/v1'),integrationId:z.uuid(),inboxId:positive,instanceId:z.uuid(),destinationRevision:positive,
  identityRevision:z.number().int().nonnegative(),numberSuffix:z.string().regex(/^\d{4}$/).nullable(),ready:z.boolean(),reason:z.string().regex(/^[A-Z_]+$/).nullable(),
});
export const CampaignReceiptSchema = z.strictObject({
  protocol:z.literal('chatwoot-campaigns/v1'),integrationId:z.uuid(),conversationId:positive,messageId:positive,
  status:z.enum(['queued','sent','delivered','read','failed','blocked','unknown']),
});
