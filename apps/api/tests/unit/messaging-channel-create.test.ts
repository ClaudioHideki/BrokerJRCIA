import { describe, expect, it } from 'vitest';
import {
  createMessagingChannelFromConfig,
  loadMessagingChannelCreateConfig,
} from '../../src/commands/messaging-channel-create.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';

const organizationId = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const providerAccountId = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const configuration = {
  organizationId,
  providerAccountId,
  phoneNumberId: '1234567890',
  wabaId: '9876543210',
  credentialReference: 'meta-primary',
};

describe('cadastro operacional local de canal Meta', () => {
  it('carrega apenas ativos pré-provisionados e exige conexão jrc_app', () => {
    expect(loadMessagingChannelCreateConfig({
      DATABASE_URL: 'postgresql://jrc_app@localhost/jrc',
      MESSAGING_CHANNEL_JSON: JSON.stringify(configuration),
    })).toEqual({ databaseUrl: 'postgresql://jrc_app@localhost/jrc', channel: configuration });
    expect(() => loadMessagingChannelCreateConfig({
      DATABASE_URL: 'postgresql://postgres@localhost/jrc',
      MESSAGING_CHANNEL_JSON: JSON.stringify(configuration),
    })).toThrow('CHANNEL_CREATE_REQUIRES_APP_ROLE');
  });

  it.each([
    { ...configuration, accessToken: 'secret' },
    { ...configuration, origin: 'https://graph.facebook.com' },
    { ...configuration, organizationId: 'forged' },
    { ...configuration, phoneNumberId: '../messages' },
  ])('rejeita configuração privilegiada ou inválida %#', invalid => {
    expect(() => loadMessagingChannelCreateConfig({
      DATABASE_URL: 'postgresql://jrc_app@localhost/jrc',
      MESSAGING_CHANNEL_JSON: JSON.stringify(invalid),
    })).toThrow('INVALID_MESSAGING_CHANNEL_CONFIGURATION');
  });

  it('cria canal tenant com provider account existente sem chamar provider externo', async () => {
    const writes: unknown[] = [];
    const repository = {
      async createChannel(_tx: unknown, input: unknown) {
        writes.push(input);
        return { ...(input as object), createdAt: new Date(), updatedAt: new Date() };
      },
    } as unknown as MessagingRepository;
    const channel = await createMessagingChannelFromConfig(configuration, {
      repository,
      async transact(selectedOrganizationId, operation) {
        expect(selectedOrganizationId).toBe(organizationId);
        return operation({} as TenantTransaction);
      },
      createId: () => 'b89542a4-cf2d-426c-8ce6-1a808ad72343',
    });
    expect(writes).toEqual([{
      id: 'b89542a4-cf2d-426c-8ce6-1a808ad72343',
      ...configuration,
      botPublicId: null,
      botOriginReference: null,
    }]);
    expect(channel.id).toBe('b89542a4-cf2d-426c-8ce6-1a808ad72343');
  });

  it('propaga recusa quando provider account não pertence ao tenant ou não corresponde à credencial', async () => {
    const repository = {
      async createChannel() { throw Object.assign(new Error('PROVIDER_ACCOUNT_NOT_FOUND'), { code: 'PROVIDER_ACCOUNT_NOT_FOUND' }); },
    } as unknown as MessagingRepository;
    await expect(createMessagingChannelFromConfig(configuration, {
      repository,
      async transact(_organizationId, operation) { return operation({} as TenantTransaction); },
      createId: () => 'b89542a4-cf2d-426c-8ce6-1a808ad72343',
    })).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_NOT_FOUND' });
  });
});
