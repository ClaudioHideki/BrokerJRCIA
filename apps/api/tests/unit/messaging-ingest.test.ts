import { describe, expect, it } from 'vitest';
import { createMetaIngestor } from '../../src/modules/messaging/ingest.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
const payload = { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'phone' }, messages: [{ id: 'wamid.incoming', from: '15550000000', type: 'text', timestamp: '1700000000', text: { body: 'Oi' } }] } }] }] };
describe('ingestão Meta', () => {
  it('resolve tenant no servidor e preserva timestamp original da mensagem', async () => {
    const writes: unknown[] = [];
    const repository = {
      async findChannel() { return { phoneNumberId: 'phone', wabaId: 'waba' }; },
      async upsertContact(_tx: unknown, input: unknown) { writes.push(input); return { id: 'contact' }; },
      async getOrCreateConversation() { return { id: 'conversation' }; },
      async recordIncoming(_tx: unknown, input: unknown) { writes.push(input); },
    } as unknown as MessagingRepository;
    const tenants: string[] = [];
    const ingest = createMetaIngestor({ repository, bindings: { phone: { organizationId: 'tenant', channelId: 'channel' } },
      async transact(org, operation) { tenants.push(org); return operation({} as TenantTransaction); } });
    await ingest(payload);
    expect(tenants).toEqual(['tenant']);
    expect(writes[0]).toMatchObject({ organizationId: 'tenant', consentStatus: 'UNKNOWN' });
    expect(writes[1]).toMatchObject({ organizationId: 'tenant', channelId: 'channel', occurredAt: new Date('2023-11-14T22:13:20.000Z'), content: { type: 'TEXT', text: 'Oi' } });
  });
  it('não persiste eventos para ativos sem associação de servidor', async () => {
    let calls = 0;
    const ingest = createMetaIngestor({ repository: {} as MessagingRepository, bindings: {}, async transact() { calls++; throw new Error(); } });
    await expect(ingest(payload)).rejects.toThrow('META_ASSET_NOT_BOUND');
    expect(calls).toBe(0);
  });
});
