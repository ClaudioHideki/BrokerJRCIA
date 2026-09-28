import { expect, it, vi } from 'vitest';
import { createChatwootControlService, type ChatwootControlOptions } from '../../src/modules/integrations/chatwoot-control-service.js';
import { IntegrationError } from '../../src/modules/integrations/integration-error.js';
import type { ChatwootControlPrincipal } from '../../src/modules/integrations/chatwoot-control-auth.js';

const org = '6174faeb-7362-43f9-8825-6559c17bfce7';
const integration = '9e1b8fab-c2e6-415a-81dc-03dd1a6e7205';
const instance = 'de6bcab4-feb6-4246-bdcb-e1adb024d65d';
const operationId = '1f99ea24-1135-46a5-83bb-326e03e17b25';
const principal = { organizationId: org } as ChatwootControlPrincipal;

function harness(operation: { state: 'PENDING' | 'SUCCEEDED'; instanceStatus: 'CONNECTING' | 'AWAITING_ACTION' | 'CONNECTED' } =
  { state: 'PENDING', instanceStatus: 'CONNECTING' }, approved = true, currentConnect = true) {
  let latestOperationId = currentConnect ? operationId : '54328f93-dabf-45d4-b0e5-38f88e55e67c';
  let integrationStatus: 'READY' | 'DISABLED' = 'READY';
  const revalidate = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM chatwoot_connections c JOIN messaging_channels')) {
      return { rows: params[0] === org && params[1] === integration ? [{ instance_id: instance, status: integrationStatus }] : [] };
    }
    if (sql.includes('SELECT id FROM provider_operations')) {
      return { rows: [{ id: latestOperationId }] };
    }
    if (sql.includes('FROM provider_operations')) {
      return { rows: params[0] === org && params[1] === instance && params[2] === operationId ? [{
        operationId, ...operation, currentConnect, reconciliationRequired: false,
        lastError: null, updatedAt: new Date('2026-09-25T12:00:00.000Z'),
      }] : [] };
    }
    if (sql.includes('FROM chatwoot_connection_health')) {
      return { rows: [{ approved_fingerprint: approved ? 'synthetic-fingerprint' : null,
        observed_fingerprint: approved ? 'synthetic-fingerprint' : null,
        observed_connected: false, identity_error: null }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const transact = vi.fn(async (_organizationId: string, work: (tx: { query: typeof query }) => Promise<unknown>) => work({ query }));
  const instances = { connectInstance: vi.fn(), getInstanceStatus: vi.fn() };
  const pairActions = { save: vi.fn(), take: vi.fn().mockResolvedValue(null) };
  const control = createChatwootControlService({
    transact, auth: { revalidate }, instances, pairActions,
    encryptionKey: Buffer.alloc(32, 4).toString('base64'),
    baseUrl: 'https://chatwoot.example.test', publicOrigin: 'https://broker.example.test',
  } as unknown as ChatwootControlOptions);
  return { control, revalidate, query, transact, instances, pairActions,
    setLatestOperationId: (id: string) => { latestOperationId = id; },
    setIntegrationStatus: (status: 'READY' | 'DISABLED') => { integrationStatus = status; } };
}

it('reads only the matching tenant, connection, instance and CONNECT operation without fetching a provider challenge', async () => {
  const h = harness();
  expect(await h.control.pairOperation(principal, integration, operationId)).toEqual({
    operationId, state: 'PENDING', instanceStatus: 'CONNECTING', reconciliationRequired: false,
    lastError: null, updatedAt: '2026-09-25T12:00:00.000Z', action: null,
  });
  expect(h.revalidate).toHaveBeenCalledWith(expect.anything(), principal, 'chatwoot:pair', integration);
  const operationQuery = h.query.mock.calls.find(([sql]) => sql.includes('FROM provider_operations'));
  expect(operationQuery?.[1]).toEqual([org, instance, operationId]);
  expect(operationQuery?.[0]).toMatch(/operation_type\s*=\s*'CONNECT'/);
  expect(h.instances.connectInstance).not.toHaveBeenCalled();
  expect(h.instances.getInstanceStatus).not.toHaveBeenCalled();
  expect(h.pairActions.take).not.toHaveBeenCalled();
  await expect(h.control.pairOperation(principal, integration, '54328f93-dabf-45d4-b0e5-38f88e55e67c'))
    .rejects.toMatchObject({ status: 404 });
  await expect(h.control.pairOperation({ ...principal, organizationId: 'e75a9631-6030-4339-87d8-e9c58176bc20' }, integration, operationId))
    .rejects.toMatchObject({ status: 404 });
});

it('returns a pending QR exactly once and revalidates authorization after consuming it', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' });
  const action = { type: 'QR_CODE' as const, encoding: 'BASE64' as const,
    value: 'synthetic-late-qr', expiresAt: new Date(Date.now() + 30_000).toISOString() };
  h.pairActions.take.mockResolvedValueOnce(action).mockResolvedValueOnce(null);
  const result = await h.control.pairOperation(principal, integration, operationId);
  expect(result.action).toEqual(action);
  expect(h.pairActions.take).toHaveBeenCalledWith({ organizationId: org, integrationId: integration, operationId });
  expect(h.revalidate).toHaveBeenCalledTimes(2);
  expect((await h.control.pairOperation(principal, integration, operationId)).action).toBeNull();
  h.pairActions.take.mockResolvedValueOnce(action);
  h.revalidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403));
  await expect(h.control.pairOperation(principal, integration, operationId)).rejects.toMatchObject({ status: 403 });
});

it('rechecks pairing permission before querying and denies revoked callers', async () => {
  const h = harness();
  h.revalidate.mockRejectedValueOnce(new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403));
  await expect(h.control.pairOperation(principal, integration, operationId)).rejects.toMatchObject({ status: 403 });
  expect(h.query).not.toHaveBeenCalled();
});

it('does not return a stale challenge after the instance connects', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'CONNECTED' });
  expect((await h.control.pairOperation(principal, integration, operationId)).action).toBeNull();
  expect(h.pairActions.take).not.toHaveBeenCalled();
});

it('does not release the QR of an older CONNECT operation while a newer attempt awaits a code', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' }, true, false);
  h.pairActions.take.mockResolvedValueOnce({ type: 'QR_CODE', encoding: 'BASE64',
    value: 'old-qr', expiresAt: new Date(Date.now() + 30_000).toISOString() });
  expect((await h.control.pairOperation(principal, integration, operationId)).action).toBeNull();
  expect(h.pairActions.take).not.toHaveBeenCalled();
});

it('drops a consumed QR if a newer CONNECT starts before the final authorization check', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' });
  h.pairActions.take.mockImplementationOnce(async () => {
    h.setLatestOperationId('54328f93-dabf-45d4-b0e5-38f88e55e67c');
    return { type: 'QR_CODE', encoding: 'BASE64', value: 'old-qr',
      expiresAt: new Date(Date.now() + 30_000).toISOString() };
  });
  expect((await h.control.pairOperation(principal, integration, operationId)).action).toBeNull();
});

it('still returns durable progress if ephemeral Redis recovery fails', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' });
  h.pairActions.take.mockRejectedValueOnce(new Error('SYNTHETIC_REDIS_OUTAGE'));
  expect(await h.control.pairOperation(principal, integration, operationId)).toMatchObject({
    operationId, state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION', action: null,
  });
  expect(h.revalidate).toHaveBeenCalledTimes(2);
});

it('does not consume an admin-started first-pair QR for an operator with only pair grant', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' }, false);
  h.revalidate.mockImplementation(async (_tx, _principal, scope: string) => {
    if (scope === 'chatwoot:manage') throw new IntegrationError('CHATWOOT_CONTROL_FORBIDDEN', 403);
  });
  await expect(h.control.pairOperation(principal, integration, operationId)).rejects.toMatchObject({ status: 403 });
  expect(h.pairActions.take).not.toHaveBeenCalled();
});

it('does not release a QR after an identity mismatch appears', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' });
  h.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM chatwoot_connections c JOIN messaging_channels')) return { rows: [{ instance_id: instance, status: 'READY' }] };
    if (sql.includes('FROM provider_operations')) return { rows: [{ operationId, state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION',
      reconciliationRequired: false, lastError: null, updatedAt: new Date('2026-09-25T12:00:00.000Z') }] };
    if (sql.includes('FROM chatwoot_connection_health')) return { rows: [{ approved_fingerprint: 'fp-a',
      observed_fingerprint: 'fp-b', observed_connected: true, identity_error: 'IDENTITY_CONFIRMATION_REQUIRED' }] };
    throw new Error(`Unexpected SQL: ${sql} ${params.length}`);
  });
  await expect(h.control.pairOperation(principal, integration, operationId)).rejects.toMatchObject({ status: 409 });
  expect(h.pairActions.take).not.toHaveBeenCalled();
});

it('does not release a pending QR after the integration is paused', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' });
  h.pairActions.take.mockResolvedValue({ type: 'QR_CODE', encoding: 'BASE64',
    value: 'paused-qr', expiresAt: new Date(Date.now() + 30_000).toISOString() });
  h.setIntegrationStatus('DISABLED');
  await expect(h.control.pairOperation(principal, integration, operationId))
    .rejects.toMatchObject({ code: 'CHATWOOT_WEBHOOK_NOT_READY', status: 409 });
  expect(h.pairActions.take).not.toHaveBeenCalled();
});

it('does not return a QR when the integration is paused during the Redis read', async () => {
  const h = harness({ state: 'SUCCEEDED', instanceStatus: 'AWAITING_ACTION' });
  h.pairActions.take.mockImplementationOnce(async () => {
    h.setIntegrationStatus('DISABLED');
    return { type: 'QR_CODE', encoding: 'BASE64', value: 'paused-during-read',
      expiresAt: new Date(Date.now() + 30_000).toISOString() };
  });
  await expect(h.control.pairOperation(principal, integration, operationId))
    .rejects.toMatchObject({ code: 'CHATWOOT_WEBHOOK_NOT_READY', status: 409 });
});
