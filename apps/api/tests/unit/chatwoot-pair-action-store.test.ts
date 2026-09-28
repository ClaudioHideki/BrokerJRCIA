import { expect, it, vi } from 'vitest';
import { createPairActionStore } from '../../src/modules/integrations/chatwoot-pair-action-store.js';

const secret = Buffer.alloc(32, 11).toString('base64');
const organizationId = '6174faeb-7362-43f9-8825-6559c17bfce7';
const integrationId = '9e1b8fab-c2e6-415a-81dc-03dd1a6e7205';
const operationId = '1f99ea24-1135-46a5-83bb-326e03e17b25';
const binding = { organizationId, integrationId, operationId };

function redis() {
  const values = new Map<string, string>();
  const set = vi.fn(async (key: string, value: string, options: { PX: number; NX: true }) => {
    if (values.has(key)) return null;
    values.set(key, value);
    return 'OK';
  });
  const getDel = vi.fn(async (key: string) => {
    const value = values.get(key) ?? null;
    values.delete(key);
    return value;
  });
  return { values, set, getDel };
}

it('caches an encrypted QR for at most 60 seconds and allows one matching retrieval', async () => {
  const client = redis();
  const now = new Date('2026-09-25T12:00:00.000Z');
  const store = createPairActionStore({ client, encryptionKey: secret, now: () => now });
  const action = { type: 'QR_CODE' as const, encoding: 'BASE64' as const, value: 'synthetic-ephemeral-qr',
    expiresAt: new Date(now.getTime() + 90_000).toISOString() };
  await store.save({ ...binding, action });
  expect(client.set).toHaveBeenCalledWith(expect.stringMatching(/^jrc:pair-action:v1:[A-Za-z0-9_-]+$/), expect.any(String), { PX: 60_000, NX: true });
  expect(JSON.stringify([...client.values])).not.toContain(action.value);
  expect(JSON.stringify([...client.values])).not.toContain(organizationId);
  expect(await store.take(binding)).toEqual(action);
  expect(await store.take(binding)).toBeNull();
});

it('cannot consume a challenge across organization, integration or operation and does not return expired actions', async () => {
  const client = redis();
  let now = new Date('2026-09-25T12:00:00.000Z');
  const store = createPairActionStore({ client, encryptionKey: secret, now: () => now });
  const action = { type: 'PAIRING_CODE' as const, code: 'SYNTHETIC', expiresAt: new Date(now.getTime() + 3_000).toISOString() };
  await store.save({ ...binding, action });
  expect(client.set.mock.calls[0]?.[2].PX).toBe(3_000);
  expect(await store.take({ ...binding, organizationId: 'e75a9631-6030-4339-87d8-e9c58176bc20' })).toBeNull();
  expect(await store.take({ ...binding, integrationId: '5a32d9f6-a1b5-45be-8fb0-d64b6bf195f0' })).toBeNull();
  expect(await store.take({ ...binding, operationId: '54328f93-dabf-45d4-b0e5-38f88e55e67c' })).toBeNull();
  now = new Date(now.getTime() + 3_001);
  expect(await store.take(binding)).toBeNull();
  expect(await store.take(binding)).toBeNull();
});
