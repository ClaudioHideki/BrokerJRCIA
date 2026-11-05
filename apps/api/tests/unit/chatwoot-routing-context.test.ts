import { describe, expect, it, vi } from 'vitest';
import { createChatwootControlService } from '../../src/modules/integrations/chatwoot-control-service.js';
import type { ChatwootControlOptions } from '../../src/modules/integrations/chatwoot-control-service.js';
import type { ChatwootControlPrincipal } from '../../src/modules/integrations/chatwoot-control-auth.js';

const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const channel = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const principal = { organizationId: org, accountId: 7, destinationRevision: 3, chatwootOrigin: 'https://central.example.com',
  authentication: { kind: 'API_KEY', organizationId: org } } as ChatwootControlPrincipal;
const empty = { integration_id: id, channel_id: channel, inbox_id: 9, integration_status: 'READY',
  bot_public_id: null, bot_origin_reference: null, owner_executor: 'NONE', owner_revision: 2,
  automation_binding_status: null, binding_revision: null, live_routing: false, deleting_at: null, complete_snapshot: true };

function setup(row: Record<string, unknown> | null = empty) {
  const query = vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
  const revalidate = vi.fn().mockResolvedValue(principal);
  const options = { transact: async (_org: string, work: (tx: unknown) => unknown) => work({ query }),
    auth: { revalidate }, encryptionKey: Buffer.alloc(32, 7).toString('base64'), publicOrigin: 'https://broker.example.com',
    instances: {}, chatwoot: {} } as unknown as ChatwootControlOptions;
  return { service: createChatwootControlService(options), query, revalidate };
}

describe('fresh control routing context', () => {
  it('proves an explicit empty owner in one read query for the requested mapping, without health writes', async () => {
    const h = setup();
    const result = await h.service.routingContext(principal, [id]);
    expect(result).toMatchObject({ organizationId: org, accountId: 7, destinationRevision: 3,
      data: [{ integrationId: id, channelId: channel, inboxId: 9, state: 'NONE', ownerRevision: 2 }] });
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.query.mock.calls[0]![0]).toMatch(/^\s*SELECT/i);
    expect(h.query.mock.calls[0]![0]).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(h.query.mock.calls[0]![1]).toEqual([org, [id]]);
    expect(h.revalidate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ owner_executor: null, owner_revision: null, complete_snapshot: false }, 'UNKNOWN'],
    [{ bot_public_id: 'legacy-bot', bot_origin_reference: 'legacy' }, 'ROUTED'],
    [{ automation_binding_status: 'PAUSED', binding_revision: 8 }, 'ROUTED'],
    [{ live_routing: true }, 'ROUTED'],
    [{ integration_status: 'FAILED' }, 'UNKNOWN'],
  ])('does not confuse incomplete or routed state with absence: %j', async (changes, state) => {
    const h = setup({ ...empty, ...changes });
    expect((await h.service.routingContext(principal, [id])).data[0]!.state).toBe(state);
  });

  it('recognizes a canonical fresh channel without manufacturing an ownership row', async () => {
    const h = setup({ ...empty, owner_executor: null, owner_revision: null, complete_snapshot: true });
    expect((await h.service.routingContext(principal, [id])).data[0]!.state).toBe('NONE');
  });

  it('never treats a retained remote bot reference after failed detach as absence', async () => {
    const h = setup({ ...empty, remote_bot_present: true });
    expect((await h.service.routingContext(principal, [id])).data[0]!.state).not.toBe('NONE');
  });

  it('rejects missing mappings and a revocation after the database read', async () => {
    await expect(setup(null).service.routingContext(principal, [id])).rejects.toMatchObject({ code: 'INTEGRATION_NOT_FOUND' });
    const h = setup();
    h.revalidate.mockResolvedValueOnce(principal).mockRejectedValueOnce(new Error('revoked'));
    await expect(h.service.routingContext(principal, [id])).rejects.toThrow('revoked');
  });
});
