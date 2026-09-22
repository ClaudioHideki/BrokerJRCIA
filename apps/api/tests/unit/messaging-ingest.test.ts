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
  it('normaliza respostas interativas, botões, contatos e localização da Meta', async () => {
    const contents: unknown[] = [];
    const repository = {
      async findChannel() { return { id: 'channel', phoneNumberId: 'phone', wabaId: 'waba' }; },
      async upsertContact() { return { id: 'contact' }; },
      async getOrCreateConversation() { return { id: 'conversation' }; },
      async recordIncoming(_tx: unknown, input: { content: unknown }) { contents.push(input.content); },
    } as unknown as MessagingRepository;
    const messages = [
      { id: 'button', from: '15550000000', timestamp: '1700000000', type: 'button', button: { text: 'Sim', payload: 'yes' } },
      { id: 'interactive', from: '15550000000', timestamp: '1700000000', type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'sales', title: 'Comercial', description: 'Falar com vendas' } } },
      { id: 'contacts', from: '15550000000', timestamp: '1700000000', type: 'contacts',
        contacts: [{ name: { formatted_name: 'Maria' }, phones: [{ phone: '+5511999999999' }] }] },
      { id: 'location', from: '15550000000', timestamp: '1700000000', type: 'location',
        location: { latitude: -23.55, longitude: -46.63, name: 'JRC', address: 'São Paulo' } },
    ];
    const ingest = createMetaIngestor({ repository, bindings: { phone: { organizationId: 'tenant', channelId: 'channel' } },
      async transact(_org, operation) { return operation({} as TenantTransaction); } });
    await ingest({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: 'phone' }, messages,
    } }] }] });
    expect(contents).toEqual([
      { type: 'TEXT', text: 'Sim' }, { type: 'TEXT', text: 'Comercial' },
      { type: 'TEXT', text: 'Maria: +5511999999999' }, { type: 'TEXT', text: 'JRC — São Paulo\n-23.55, -46.63' },
    ]);
  });
});
