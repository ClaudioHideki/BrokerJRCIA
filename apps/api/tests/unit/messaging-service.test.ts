import { describe, expect, it } from 'vitest';
import { createMessagingService } from '../../src/modules/messaging/service.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';

function activeTemplateTransaction(): TenantTransaction {
  let inserts = 0;
  return { query: async (sql: string) => sql.includes('INSERT INTO idempotency_records')
    ? { rows: [{ id: `record-${++inserts}` }] }
    : { rows: [{ active: true }] } } as unknown as TenantTransaction;
}

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
  it('consulta a revisão do template somente na WABA do canal autorizado e não presume aprovação se não observado', async () => {
    const observedWabas: string[] = [];
    const service = createMessagingService({
      repository: { async findChannel(_tx: unknown, _org: string, channelId: string) {
        if (channelId === 'foreign') return null;
        return { id: channelId, organizationId: 'tenant', provider: channelId === 'qr' ? 'BAILEYS' : 'META',
          wabaId: channelId === 'channel-b' ? 'waba-b' : 'waba-a' };
      } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) { return operation({} as TenantTransaction); },
      async resolveMetaClient(channel) {
        observedWabas.push(channel.wabaId!);
        return { async listTemplates() { return channel.wabaId === 'waba-a' ? [
          { id: '20001', name: 'aviso', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY',
            components: [{ type: 'BODY', text: 'Olá' }] },
        ] : []; }, async createTextTemplate() { throw new Error('unexpected'); } };
      },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    const found = await service.getTemplateStatus('tenant', 'channel-a', '20001');
    expect(found).toMatchObject({ observation: 'OBSERVED', id: '20001', template: { status: 'APPROVED', name: 'aviso' } });
    expect(found.checkedAt).toEqual(expect.any(String));
    const absent = await service.getTemplateStatus('tenant', 'channel-b', '20001');
    expect(absent).toMatchObject({ observation: 'NOT_OBSERVED', id: '20001' });
    expect(absent).not.toHaveProperty('template');
    expect(observedWabas).toEqual(['waba-a', 'waba-b']);
    await expect(service.getTemplateStatus('tenant', 'foreign', '20001')).rejects.toMatchObject({ status: 404 });
    await expect(service.getTemplateStatus('tenant', 'qr', '20001')).rejects.toMatchObject({ status: 422 });
    expect(observedWabas).toEqual(['waba-a', 'waba-b']);
  });
  it('submete template de texto somente pelo WABA do canal Meta da empresa, fora da transação', async () => {
    let inTransaction = false;
    const submitted: unknown[] = [];
    const service = createMessagingService({
      repository: { async findChannel(_tx: unknown, organizationId: string) {
        return { id: 'channel', organizationId, provider: 'META', wabaId: '10001' };
      } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) {
        inTransaction = true;
        try { return await operation(activeTemplateTransaction()); } finally { inTransaction = false; }
      },
      async resolveMetaClient() {
        expect(inTransaction).toBe(false);
        return { async listTemplates() { return []; }, async findTemplateByName() { return undefined; }, async createTextTemplate(input: { name: string; language: string; category: 'UTILITY' | 'MARKETING'; body: string }) {
          submitted.push(input);
          return { id: '20001', status: 'PENDING', category: 'UTILITY' };
        } };
      },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    await expect(service.createTextTemplate('tenant', 'channel', {
      name: 'aviso_entrega', language: 'pt_BR', category: 'UTILITY', body: 'Seu pedido está pronto.',
    }, 'submit-1')).resolves.toEqual({
      id: '20001', name: 'aviso_entrega', language: 'pt_BR', status: 'PENDING', category: 'UTILITY',
    });
    expect(submitted).toEqual([{ name: 'aviso_entrega', language: 'pt_BR', category: 'UTILITY', body: 'Seu pedido está pronto.' }]);
  });
  it('não presume aprovação nem revisão pendente quando a Meta devolve somente o ID', async () => {
    const service = createMessagingService({
      repository: { async findChannel() { return { id: 'channel', organizationId: 'tenant', provider: 'META', wabaId: '10001' }; } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) { return operation(activeTemplateTransaction()); },
      async resolveMetaClient() { return { async listTemplates() { return []; }, async findTemplateByName() { return undefined; }, async createTextTemplate() { return { id: '20002' }; } }; },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    await expect(service.createTextTemplate('tenant', 'channel', {
      name: 'aviso', language: 'pt_BR', category: 'UTILITY', body: 'Olá',
    }, 'submit-2')).resolves.toMatchObject({ id: '20002', status: 'STATUS_NOT_RETURNED', category: 'UTILITY' });
  });
  it('rejeita canal QR e outro tenant antes de resolver credenciais Meta', async () => {
    let providerCalls = 0;
    const service = createMessagingService({
      repository: { async findChannel(_tx: unknown, _org: string, channelId: string) {
        return channelId === 'qr' ? { id: 'qr', organizationId: 'tenant', provider: 'BAILEYS' } : null;
      } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) { return operation({ query: async () => ({ rows: [{ active: true }] }) } as unknown as TenantTransaction); },
      async resolveMetaClient() { providerCalls++; throw new Error('unexpected'); },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    const input = { name: 'aviso', language: 'pt_BR', category: 'UTILITY', body: 'Olá' } as const;
    await expect(service.createTextTemplate('tenant', 'foreign', input, 'foreign-key')).rejects.toMatchObject({ status: 404 });
    await expect(service.createTextTemplate('tenant', 'qr', input, 'qr-key')).rejects.toMatchObject({ status: 422 });
    expect(providerCalls).toBe(0);
  });
  it('não submete template quando a empresa está suspensa', async () => {
    let repositoryCalls = 0;
    let providerCalls = 0;
    const service = createMessagingService({
      repository: { async findChannel() { repositoryCalls++; throw new Error('unexpected'); } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) {
        return operation({ query: async () => ({ rows: [{ active: false }] }) } as unknown as TenantTransaction);
      },
      async resolveMetaClient() { providerCalls++; throw new Error('unexpected'); },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    await expect(service.createTextTemplate('tenant', 'channel', {
      name: 'aviso', language: 'pt_BR', category: 'UTILITY', body: 'Olá',
    }, 'suspended-key')).rejects.toMatchObject({ status: 403, code: 'ORGANIZATION_NOT_ACTIVE' });
    expect(repositoryCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });
  it('distingue recusa definitiva da Meta de submissão de resultado incerto', async () => {
    const input = { name: 'aviso', language: 'pt_BR', category: 'UTILITY', body: 'Olá' } as const;
    const build = (errorCode: string) => createMessagingService({
      repository: { async findChannel(_tx: unknown, organizationId: string) {
        return { id: 'channel', organizationId, provider: 'META', wabaId: '10001' };
      } } as unknown as MessagingRepository,
      async runInOrganizationTransaction(_org, operation) {
        return operation(activeTemplateTransaction());
      },
      async resolveMetaClient() { return { async listTemplates() { return []; }, async findTemplateByName() { return undefined; },
        async createTextTemplate() { throw Object.assign(new Error('secret upstream body'), { code: errorCode }); } }; },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    await expect(build('META_REQUEST_REJECTED').createTextTemplate('tenant', 'channel', input, 'reject-key'))
      .rejects.toMatchObject({ status: 422, code: 'META_TEMPLATE_REJECTED' });
    await expect(build('META_TEMPLATE_SUBMISSION_UNKNOWN').createTextTemplate('tenant', 'channel', input, 'unknown-key'))
      .rejects.toMatchObject({ status: 503, code: 'META_TEMPLATE_SUBMISSION_UNKNOWN' });
  });
});
