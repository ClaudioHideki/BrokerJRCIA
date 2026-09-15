import { describe, expect, it } from 'vitest';
import { createMessagingService } from '../../src/modules/messaging/service.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';

describe('serviço de mensageria', () => {
  it('configura bot somente após validar canal tenant e referência allowlist fora da transação', async () => {
    let inTransaction = false;
    const operations: unknown[] = [];
    const channel = { id: 'channel', organizationId: 'tenant', botPublicId: null, botOriginReference: null };
    const service = createMessagingService({
      repository: {
        async findChannel(_tx: unknown, organizationId: string, channelId: string) {
          operations.push(['find', organizationId, channelId]); return channel;
        },
        async setChannelBot(_tx: unknown, input: unknown) {
          operations.push(['set', input]);
          return { ...channel, botPublicId: 'support', botOriginReference: 'typebot-cloud' };
        },
      } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) {
        inTransaction = true;
        try { return await operation({} as TenantTransaction); } finally { inTransaction = false; }
      },
      async resolveMetaClient() { throw new Error('unexpected'); },
      async resolveTypebotClient(reference, organizationId) {
        expect(inTransaction).toBe(false);
        operations.push(['resolve', reference, organizationId]);
        return {};
      },
    });
    await expect(service.configureBot('tenant', 'channel', {
      publicId: 'support', originReference: 'typebot-cloud',
    })).resolves.toEqual({ id: 'channel', provider: 'META', botPublicId: 'support' });
    expect(operations).toEqual([
      ['find', 'tenant', 'channel'],
      ['resolve', 'typebot-cloud', 'tenant'],
      ['set', { organizationId: 'tenant', channelId: 'channel', botPublicId: 'support', botOriginReference: 'typebot-cloud' }],
    ]);
  });
  it('não consulta registry nem altera canal de outro tenant', async () => {
    let registryCalls = 0;
    let mutations = 0;
    const service = createMessagingService({
      repository: {
        async findChannel() { return null; },
        async setChannelBot() { mutations++; throw new Error('unexpected'); },
      } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) { return operation({} as TenantTransaction); },
      async resolveMetaClient() { throw new Error('unexpected'); },
      async resolveTypebotClient() { registryCalls++; return {}; },
    });
    await expect(service.configureBot('tenant', 'foreign-channel', {
      publicId: 'support', originReference: 'missing',
    })).rejects.toMatchObject({ status: 404 });
    expect(registryCalls).toBe(0);
    expect(mutations).toBe(0);
  });
  it('rejeita referência Typebot ausente da allowlist antes de alterar o canal', async () => {
    let mutations = 0;
    const service = createMessagingService({
      repository: {
        async findChannel(_tx: unknown, organizationId: string) { return { id: 'channel', organizationId }; },
        async setChannelBot() { mutations++; throw new Error('unexpected'); },
      } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) { return operation({} as TenantTransaction); },
      async resolveMetaClient() { throw new Error('unexpected'); },
      async resolveTypebotClient() { throw new Error('TYPEBOT_NOT_CONFIGURED'); },
    });
    await expect(service.configureBot('tenant', 'channel', {
      publicId: 'support', originReference: 'missing',
    })).rejects.toMatchObject({ code: 'TYPEBOT_NOT_CONFIGURED', status: 422 });
    expect(mutations).toBe(0);
  });
  it('fecha transação antes de buscar templates no provider e não publica credenciais', async () => {
    let inTransaction = false;
    const service = createMessagingService({
      repository: { async findChannel(_tx: unknown, org: string) { return { id: 'channel', organizationId: org, credentialReference: 'private-reference' }; } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) {
        inTransaction = true;
        try { return await operation({} as TenantTransaction); } finally { inTransaction = false; }
      },
      async resolveMetaClient() {
        expect(inTransaction).toBe(false);
        return { async listTemplates() { return [
          { id: 'template', name: 'hello', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá {{1}}, pedido {{2}}.' }], accessToken: 'never-public' },
          { id: 'unsupported', name: 'media', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Olá' }] },
        ]; } } as never;
      },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    const result = await service.listTemplates('tenant', 'channel');
    expect(result).toEqual({ data: [
      { id: 'template', name: 'hello', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', bodyVariableCount: 2 },
      { id: 'unsupported', name: 'media', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', bodyVariableCount: null },
    ] });
  });
  it('rejeita canal de outra organização antes de qualquer chamada externa', async () => {
    let providerCalls = 0;
    const service = createMessagingService({
      repository: { async findChannel() { return null; } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) { return operation({} as TenantTransaction); },
      async resolveMetaClient() { providerCalls++; throw new Error('unexpected'); },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    await expect(service.listTemplates('tenant', 'other')).rejects.toMatchObject({ status: 404 });
    expect(providerCalls).toBe(0);
  });
});
