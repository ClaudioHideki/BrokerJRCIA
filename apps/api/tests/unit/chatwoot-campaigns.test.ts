import { expect, it, vi } from 'vitest';
import { readCampaignTransport, readCampaignReceipt } from '../../src/modules/integrations/chatwoot-campaigns.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
const scope = { organizationId: 'synthetic-org', accountId: 4, destinationRevision: 2 };
const ready = { inbox_id: '9', instance_id: 'synthetic-instance', transport: 'BROKER_TRANSPORT', executor: 'EXTERNAL', status: 'READY', instance_status: 'CONNECTED', identity_ready: true, callback_ready: true, identity_revision: 3, observed_last4: '0000' };
const tx = (rows: unknown[]) => ({ query: vi.fn().mockResolvedValue({ rows }) }) as unknown as TenantTransaction;
it('advertises only the existing external executor transport without secrets or provider calls', async () => {
  const t = tx([ready]);
  const result = await readCampaignTransport(t, scope, 'integration');
  expect(result).toMatchObject({ protocol: 'chatwoot-campaigns/v1', ready: true, inboxId: 9, reason: null, identityRevision: 3 });
  expect(result).not.toHaveProperty('encrypted_webhook_secret');
  expect(t.query).toHaveBeenCalledWith(expect.stringContaining('organization_id=$1'), ['synthetic-org', 'integration', 4, 2]);
});
it.each(['BROKER', 'CENTRAL', null])('keeps executor %s protected rather than impersonating a human', async executor => {
  expect(await readCampaignTransport(tx([{ ...ready, executor }]), scope, 'integration')).toMatchObject({ ready: false, reason: 'CAMPAIGN_EXECUTOR_EXTERNAL_REQUIRED' });
});
it.each(['identity_ready', 'callback_ready'])('does not accept absent %s evidence', async field => {
  expect((await readCampaignTransport(tx([{ ...ready, [field]: false }]), scope, 'integration')).ready).toBe(false);
});
it('rejects an unavailable binding', async () => {
  await expect(readCampaignTransport(tx([]), scope, 'integration')).rejects.toMatchObject({ code: 'CAMPAIGN_BINDING_NOT_FOUND' });
});
it.each([
  [['ACCEPTED'], 'queued'], [['SENDING'], 'queued'], [['SENT'], 'sent'],
  [['READ', 'DELIVERED'], 'delivered'], [['READ', 'SENT'], 'sent'], [['READ', 'READ'], 'read'],
  [['SENT', 'UNKNOWN'], 'unknown'], [['READ', 'FAILED'], 'failed'],
])('aggregates provider evidence %j as %s', async (states, status) => {
  const t = tx((states as string[]).map(state => ({ state })));
  expect(await readCampaignReceipt(t, scope, 'integration', 18, 21)).toEqual({ protocol: 'chatwoot-campaigns/v1', integrationId: 'integration', conversationId: 18, messageId: 21, status });
  expect(t.query).toHaveBeenCalledWith(expect.any(String), ['synthetic-org', 'integration', 4, 2, 18, 21]);
});
it('never treats an ignored automation webhook or absence of provider evidence as sent', async () => {
  const t = tx([]);
  expect((await readCampaignReceipt(t, scope, 'integration', 18, 21)).status).toBe('queued');
  expect((await readCampaignReceipt(tx([{ state: null, disposition: 'IGNORED' }]), scope, 'integration', 18, 21)).status).toBe('blocked');
});
