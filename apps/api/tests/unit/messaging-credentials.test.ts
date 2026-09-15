import { describe, expect, it } from 'vitest';
import { createMetaClientResolver, createTypebotClientResolver } from '../../src/modules/messaging/credentials.js';
import type { MessagingChannel } from '../../src/modules/messaging/types.js';

describe('credenciais Meta de servidor', () => {
  it('recusa referência não cadastrada sem vazar configuração', async () => {
    const resolve = createMetaClientResolver({ META_CREDENTIALS_JSON: '{"valid":{"accessToken":"private-token","graphVersion":"v25.0","organizationIds":["4f2491a2-6853-4ac2-a7ef-c997813a9182"]}}' });
    await expect(resolve({ credentialReference: 'other' } as MessagingChannel)).rejects.toMatchObject({ message: 'META_CHANNEL_NOT_CONFIGURED', status: 503 });
  });
  it('falha com erro genérico para configuração inválida', () => {
    expect(() => createMetaClientResolver({ META_CREDENTIALS_JSON: '{private-token' })).toThrow('INVALID_META_CREDENTIAL_REGISTRY');
  });
  it('constrói cliente apenas com credencial referenciada e ativos do canal', async () => {
    const resolve = createMetaClientResolver({ META_CREDENTIALS_JSON: '{"main":{"accessToken":"private-token","graphVersion":"v25.0","organizationIds":["4f2491a2-6853-4ac2-a7ef-c997813a9182"]}}' });
    const client = await resolve({ organizationId: '4f2491a2-6853-4ac2-a7ef-c997813a9182', credentialReference: 'main', phoneNumberId: '12345', wabaId: '45678' } as MessagingChannel);
    expect(typeof client.listTemplates).toBe('function');
    expect(JSON.stringify(client)).not.toContain('private-token');
  });
});

describe('destinos Typebot registrados no servidor', () => {
  const organizationId = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
  const otherOrganizationId = 'a243ac94-4937-4cdb-b113-0834488ee538';
  it('recusa referência desconhecida sem usar URL enviada pelo usuário', async () => {
    const resolve = createTypebotClientResolver({ TYPEBOT_ORIGINS_JSON: '{}' });
    await expect(resolve('https://attacker.invalid', organizationId)).rejects.toThrow('TYPEBOT_NOT_CONFIGURED');
  });
  it('recusa origem privada e não revela token no erro', async () => {
    const resolve = createTypebotClientResolver({ TYPEBOT_ORIGINS_JSON: `{"private":{"origin":"https://127.0.0.1","accessToken":"secret-value","organizationIds":["${organizationId}"]}}` });
    await expect(resolve('private', organizationId)).rejects.toThrow();
  });
  it('cria cliente para origem HTTPS autorizada e mantém segredo privado', async () => {
    const resolve = createTypebotClientResolver({ TYPEBOT_ORIGINS_JSON: `{"cloud":{"origin":"https://typebot.io","accessToken":"secret-value","organizationIds":["${organizationId}"]}}` });
    const client = await resolve('cloud', organizationId);
    expect(typeof client.startChat).toBe('function');
    expect(JSON.stringify(client)).not.toContain('secret-value');
  });
  it('nega referência válida a tenant fora da allowlist', async () => {
    const resolve = createTypebotClientResolver({ TYPEBOT_ORIGINS_JSON: `{"cloud":{"origin":"https://typebot.io","organizationIds":["${organizationId}"]}}` });
    await expect(resolve('cloud', otherOrganizationId)).rejects.toThrow('TYPEBOT_NOT_CONFIGURED');
  });
  it('falha fechado para entrada antiga sem allowlist de organizações', () => {
    expect(() => createTypebotClientResolver({ TYPEBOT_ORIGINS_JSON: '{"cloud":{"origin":"https://typebot.io"}}' }))
      .toThrow('INVALID_TYPEBOT_ORIGIN_REGISTRY');
  });
});

it('rejects a known Meta credential belonging to another organization', async () => {
  const resolve = createMetaClientResolver({ META_CREDENTIALS_JSON: JSON.stringify({ main: {
    accessToken: 'fixture-secret', graphVersion: 'v25.0', organizationIds: ['4f2491a2-6853-4ac2-a7ef-c997813a9182'],
  } }) });
  await expect(resolve({ organizationId: 'a243ac94-4937-4cdb-b113-0834488ee538', credentialReference: 'main' } as MessagingChannel))
    .rejects.toThrow('META_CHANNEL_NOT_CONFIGURED');
});
