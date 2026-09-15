import { afterEach, describe, expect, it } from 'vitest';
import { issueAccessToken } from '@jrc/security';
import { buildApp } from '../../src/app.js';

const org = '4f2491a2-6853-4ac2-a7ef-c997813a9182';
const channel = '81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const secret = 'messaging-test-secret-at-least-32-bytes';
const apps: ReturnType<typeof buildApp>[] = [];
async function harness(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'OWNER') {
  const organizations: string[] = [];
  const botConfigurations: unknown[] = [];
  let mutations = 0;
  let currentRole: typeof role | null = role;
  const app = buildApp({ nodeEnv: 'test', passwordVerifierInitializer: async () => ({ async verifyPasswordOrDummy() { return false; } }), messaging: {
    jwtSecret: secret, async authenticateApiKey(raw) { return raw === 'existing-instance-key' ? { apiKeyId: channel, organizationId: org, scopes: ['instances:read', 'instances:connect'] } : null; },
    async resolveCurrentRole() { return currentRole; },
    service: {
      async listChannels(organizationId: string) { organizations.push(organizationId); return { data: [{ id: channel, provider: 'META' as const, botPublicId: null, credentialReference: 'must-not-leak' }] }; },
      async listTemplates() { return { data: [] }; }, async listConversations() { return { data: [] }; }, async listMessages() { return { data: [] }; },
      async sendTemplate() { mutations++; return { id: channel, direction: 'OUTGOING' as const, state: 'ACCEPTED' as const, text: 'boas_vindas' }; },
      async sendText(organizationId,channelId,input){organizations.push(organizationId);mutations++;return {id:channelId,direction:'OUTGOING' as const,state:'ACCEPTED' as const,text:input.text};},
      async readMedia(organizationId){organizations.push(organizationId);return {bytes:new Uint8Array([1,2]),mimeType:'image/png',kind:'image' as const,fileName:'foto.png'};},
      async configureBot(organizationId, channelId, input) {
        mutations++; botConfigurations.push({ organizationId, channelId, input });
        return { id: channelId, provider: 'META' as const, botPublicId: input.publicId };
      },
      async setMode() { mutations++; return { id: channel, channelId: channel, contactId: channel, mode: 'HUMAN' as const }; },
    },
  } });
  apps.push(app);
  const token = await issueAccessToken({ userId: channel, organizationId: org, role }, secret);
  return { app, headers: { authorization: `Bearer ${token}` }, organizations, botConfigurations, mutations: () => mutations,
    setCurrentRole(value: typeof role | null) { currentRole = value; } };
}
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
it('envia texto com idempotência, tenant derivado e bloqueio de VIEWER',async()=>{
 const h=await harness();const input={method:'POST' as const,url:`/v1/messaging/channels/${channel}/text`,headers:{...h.headers,'idempotency-key':channel},payload:{conversationId:channel,text:'Olá'}};
 expect((await h.app.inject(input)).statusCode).toBe(202);expect(h.organizations).toEqual([org]);
 h.setCurrentRole('VIEWER');expect((await h.app.inject(input)).statusCode).toBe(403);expect(h.mutations()).toBe(1);
});
it('entrega anexo somente após autenticação, sem cache ou execução no navegador',async()=>{
 const h=await harness();const url=`/v1/messaging/media/${channel}`;
 expect((await h.app.inject({url})).statusCode).toBe(401);
 const response=await h.app.inject({url,headers:h.headers});expect(response.statusCode).toBe(200);expect(response.rawPayload).toEqual(Buffer.from([1,2]));
 expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['content-disposition']).toContain('attachment');expect(h.organizations).toEqual([org]);
});

it('revoga privilégios de automação de JWT antigo após mudança de membership', async () => {
  const h = await harness('OWNER');
  h.setCurrentRole('OPERATOR');
  const response = await h.app.inject({ method: 'PATCH', url: `/v1/messaging/channels/${channel}/automation`, headers: h.headers,
    payload: { publicId: 'support', originReference: 'cloud' } });
  expect(response.statusCode).toBe(403);
  expect(h.mutations()).toBe(0);
});

it('nega leitura e envio depois de remover membership mesmo com JWT ainda válido', async () => {
  const h = await harness('OWNER');
  h.setCurrentRole(null);
  expect((await h.app.inject({ url: '/v1/messaging/channels', headers: h.headers })).statusCode).toBe(403);
  expect(h.organizations).toEqual([]);
});

it('não amplia os privilégios de uma API key válida de instâncias', async () => {
  const h = await harness();
  const response = await h.app.inject({ url: '/v1/messaging/channels', headers: { 'x-jrc-api-key': 'existing-instance-key' } });
  expect(response.statusCode).toBe(403);
  expect(h.organizations).toEqual([]);
});
describe('API JRC de mensageria', () => {
  it('preserva erros de JSON inválido como erro do cliente', async () => {
    const h = await harness();
    const response = await h.app.inject({ method: 'PATCH', url: `/v1/messaging/conversations/${channel}/mode`, headers: { ...h.headers, 'content-type': 'application/json' }, payload: '{broken' });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('broken');
  });
  it('deriva organização da identidade e remove referências de credenciais', async () => {
    const h = await harness();
    const response = await h.app.inject({ url: '/v1/messaging/channels', headers: h.headers });
    expect(response.statusCode).toBe(200);
    expect(h.organizations).toEqual([org]);
    expect(response.body).not.toContain('must-not-leak');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('rejeita identidade ausente e organização forjada na query', async () => {
    const h = await harness();
    expect((await h.app.inject({ url: '/v1/messaging/channels' })).statusCode).toBe(401);
    expect((await h.app.inject({ url: '/v1/messaging/channels?organizationId=forged', headers: h.headers })).statusCode).toBe(400);
    expect(h.organizations).toEqual([]);
  });
  it('impede envio e transferência para VIEWER', async () => {
    const h = await harness('VIEWER');
    expect((await h.app.inject({ method: 'POST', url: `/v1/messaging/channels/${channel}/messages`, headers: { ...h.headers, 'idempotency-key': channel }, payload: { conversationId: channel, name: 'hello', language: 'pt_BR', variables: [] } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/messaging/conversations/${channel}/mode`, headers: h.headers, payload: { mode: 'HUMAN' } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'PATCH', url: `/v1/messaging/channels/${channel}/automation`, headers: h.headers, payload: { publicId: 'support', originReference: 'cloud' } })).statusCode).toBe(403);
    expect(h.mutations()).toBe(0);
  });
  it.each(['OWNER', 'ADMIN'] as const)('configura automação como %s derivando tenant do JWT', async role => {
    const h = await harness(role);
    const response = await h.app.inject({ method: 'PATCH', url: `/v1/messaging/channels/${channel}/automation`, headers: h.headers,
      payload: { publicId: 'support', originReference: 'typebot-cloud' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: channel, provider: 'META', botPublicId: 'support' });
    expect(h.botConfigurations).toEqual([{ organizationId: org, channelId: channel,
      input: { publicId: 'support', originReference: 'typebot-cloud' } }]);
  });
  it('impede OPERATOR de alterar configuração de automação', async () => {
    const h = await harness('OPERATOR');
    const response = await h.app.inject({ method: 'PATCH', url: `/v1/messaging/channels/${channel}/automation`, headers: h.headers,
      payload: { publicId: 'support', originReference: 'typebot-cloud' } });
    expect(response.statusCode).toBe(403);
    expect(h.mutations()).toBe(0);
  });
  it('rejeita URL, token e organização forjada na configuração', async () => {
    const h = await harness();
    for (const privileged of [
      { publicId: 'support', originReference: 'cloud', url: 'https://typebot.example' },
      { publicId: 'support', originReference: 'cloud', accessToken: 'secret' },
      { publicId: 'support', originReference: 'cloud', organizationId: org },
    ]) {
      expect((await h.app.inject({ method: 'PATCH', url: `/v1/messaging/channels/${channel}/automation`, headers: h.headers, payload: privileged })).statusCode).toBe(400);
    }
    expect(h.mutations()).toBe(0);
  });
  it('exige idempotência no envio e retorna aceitação sem afirmar entrega', async () => {
    const h = await harness();
    const input = { method: 'POST' as const, url: `/v1/messaging/channels/${channel}/messages`, payload: { conversationId: channel, name: 'hello', language: 'pt_BR', variables: [] } };
    expect((await h.app.inject({ ...input, headers: h.headers })).statusCode).toBe(400);
    const response = await h.app.inject({ ...input, headers: { ...h.headers, 'idempotency-key': channel } });
    expect(response.statusCode).toBe(202);
    expect(response.json().state).toBe('ACCEPTED');
    expect(h.mutations()).toBe(1);
  });
});
