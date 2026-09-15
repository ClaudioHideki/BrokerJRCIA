import { expect, it, vi } from 'vitest';
import { EvolutionMessagingClient } from '../src/evolution/messaging.js';

it('envia texto pela instância privada e registra somente aceitação', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'qr-accepted' } })));
  const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.test', apiKey: 'test-secret', instanceKey: 'private/name', fetch: request });
  await expect(client.sendText('15550000001', 'Oi')).resolves.toEqual({ status: 'ACCEPTED', upstreamMessageId: 'qr-accepted' });
  expect(String(request.mock.calls[0]![0])).toBe('https://engine.test/message/sendText/private%2Fname');
  expect(request.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
  expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({ number: '15550000001', text: 'Oi' });
});
it('não repete POST quando a resposta se perde', async () => {
  const request = vi.fn().mockRejectedValue(new Error('private network body'));
  const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.test', apiKey: 'test-secret', instanceKey: 'instance', fetch: request });
  await expect(client.sendText('15550000001', 'Oi')).rejects.toMatchObject({ code: 'QR_SEND_UNKNOWN', message: 'QR_SEND_UNKNOWN' });
  expect(request).toHaveBeenCalledTimes(1);
});
it('configura autenticação do webhook sem usar o segredo global no callback', async () => {
  const request = vi.fn().mockResolvedValue(new Response('{}'));
  const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.test', apiKey: 'global-private', instanceKey: 'instance', fetch: request });
  await client.configureWebhook('https://broker.test/v1/webhooks/whatsapp/channel', 'channel-secret');
  const body = JSON.parse(request.mock.calls[0]![1].body);
  expect(body.webhook.headers).toEqual({ Authorization: 'Bearer channel-secret' });
  expect(body.webhook.events).toEqual(['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE']);
  expect(JSON.stringify(body)).not.toContain('global-private');
});
it('rejeita destinatário inválido antes de chamar o motor', async () => {
  const request = vi.fn();
  const client = new EvolutionMessagingClient({ baseUrl: 'https://engine.test', apiKey: 'test-secret', instanceKey: 'instance', fetch: request });
  await expect(client.sendText('group@g.us', 'Oi')).rejects.toMatchObject({ code: 'INVALID_QR_INPUT' });
  expect(request).not.toHaveBeenCalled();
});
