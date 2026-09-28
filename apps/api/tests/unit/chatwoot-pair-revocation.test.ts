import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createChatwootControlService, type ChatwootControlOptions } from '../../src/modules/integrations/chatwoot-control-service.js';
import { createIntegrationSecrets } from '../../src/modules/integrations/secrets.js';
import type { ChatwootControlPrincipal } from '../../src/modules/integrations/chatwoot-control-auth.js';

it('does not release or cache a provider QR when its Chatwoot connection is disabled during pairing', async () => {
  const organizationId = randomUUID(), integrationId = randomUUID(), instanceId = randomUUID();
  const publicOrigin = 'https://broker.example.test', baseUrl = 'https://chatwoot.example.test';
  const key = Buffer.alloc(32, 5).toString('base64'), vault = createIntegrationSecrets(key);
  const principal = { organizationId, accountId: 1 } as ChatwootControlPrincipal;
  const action = { type: 'QR_CODE' as const, encoding: 'BASE64' as const,
    value: 'synthetic-revoked-qr', expiresAt: new Date(Date.now() + 30_000).toISOString() };
  let connectionStatus: 'READY' | 'DISABLED' = 'READY';
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM chatwoot_connections c JOIN messaging_channels'))
      return { rows: [{ id: integrationId, instance_id: instanceId, channel_id: randomUUID(), status: connectionStatus,
        inbox_id: '31', encrypted_webhook_secret: vault.encrypt(`${organizationId}:chatwoot-webhook:${integrationId}`, 'synthetic-secret') }] };
    if (sql.includes('FROM chatwoot_connection_health'))
      return { rows: [{ approved_fingerprint: 'synthetic-fingerprint', observed_fingerprint: 'synthetic-fingerprint',
        observed_connected: false, identity_error: null, pair_window_key: null, active: false }] };
    if (sql.includes('FROM chatwoot_destinations'))
      return { rows: [{ organizationId, baseUrl, mode: 'MANAGED', approvalStatus: 'APPROVED', mediaOrigins: [], revision: 1 }] };
    if (sql.includes('FROM chatwoot_accounts WHERE'))
      return { rows: [{ organization_id: organizationId, base_url: baseUrl, account_id: '1', status: 'READY', credential_version: 1,
        encrypted_token: vault.encrypt(`${organizationId}:chatwoot-account`, 'synthetic-token') }] };
    if (sql.includes('INSERT INTO idempotency_records')) return { rows: [{ id: randomUUID() }] };
    if (sql.includes('SELECT pair_window_key,pair_window_expires_at')) return { rows: [{ pair_window_key: null, active: false }] };
    return { rows: [], rowCount: 1 };
  });
  const transact = async (_org: string, work: (tx: { query: typeof query }) => Promise<unknown>) => work({ query });
  const connectInstance = vi.fn(async () => {
    connectionStatus = 'DISABLED';
    return { operationId: randomUUID(), action };
  });
  const pairActions = { save: vi.fn(), take: vi.fn() };
  const control = createChatwootControlService({
    baseUrl, publicOrigin, encryptionKey: key, transact,
    fetch: vi.fn(async (url: string) => Response.json(url.endsWith('/profile')
      ? { accounts: [{ id: 1, role: 'administrator' }] }
      : { id: 31, name: 'Synthetic inbox', channel_type: 'Channel::Api', webhook_url: `${publicOrigin}/v1/integrations/chatwoot/${integrationId}/events`, secret: 'synthetic-secret' })) as unknown as typeof fetch,
    auth: { revalidate: vi.fn(), delegate: vi.fn().mockReturnValue({ organizationId }) },
    instances: { connectInstance },
    health: { refresh: vi.fn(), enroll: vi.fn() },
    pairActions,
  } as unknown as ChatwootControlOptions);

  await expect(control.pair(principal, integrationId, randomUUID()))
    .rejects.toMatchObject({ code: 'CHATWOOT_WEBHOOK_NOT_READY', status: 409 });
  expect(connectInstance).toHaveBeenCalledTimes(1);
  expect(pairActions.save).not.toHaveBeenCalled();
});
