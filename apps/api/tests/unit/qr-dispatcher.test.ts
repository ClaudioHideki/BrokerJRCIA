import { expect, it, vi } from 'vitest';
import { dispatchClaim, type DispatchPorts } from '../../src/modules/messaging/dispatcher.js';
import type { OutboxClaim } from '../../src/modules/messaging/types.js';

function setup(content: unknown) {
  const claim = { channel: { provider: 'BAILEYS' }, contact: { externalId: '15550000001' }, message: { content } } as OutboxClaim;
  const client = { sendText: vi.fn().mockResolvedValue({ upstreamMessageId: 'qr-id' }), sendTemplate: vi.fn(), listTemplates: vi.fn().mockResolvedValue([]) };
  const ports: DispatchPorts = { validate: vi.fn().mockResolvedValue(true), resolveClient: vi.fn().mockResolvedValue(client), complete: vi.fn() };
  return { claim, client, ports };
}
it('preserva incerteza de envio QR sem afirmar erro Meta', async () => {
  const h = setup({ type: 'TEXT', text: 'Oi' });
  h.client.sendText.mockRejectedValue(new Error('timeout'));
  await dispatchClaim(h.claim, h.ports);
  expect(h.ports.complete).toHaveBeenCalledWith(h.claim, { state: 'UNKNOWN', canonicalErrorCode: 'QR_SEND_UNKNOWN' });
  expect(h.client.sendText).toHaveBeenCalledTimes(1);
});
it('reagenda rejeição temporária antes de aceite sem torná-la resultado incerto',async()=>{
 const h=setup({type:'TEXT',text:'Oi'});h.client.sendText.mockRejectedValue({code:'QR_RATE_LIMITED'});
 await dispatchClaim(h.claim,h.ports);
 expect(h.ports.complete).toHaveBeenCalledWith(h.claim,{state:'FAILED',canonicalErrorCode:'QR_RATE_LIMITED',retrySafe:true});
});
it('rejeita template em canal QR antes de consultar o motor', async () => {
  const h = setup({ type: 'TEMPLATE', name: 'hello', language: 'pt_BR', variables: [] });
  await dispatchClaim(h.claim, h.ports);
  expect(h.ports.resolveClient).not.toHaveBeenCalled();
  expect(h.ports.complete).toHaveBeenCalledWith(h.claim, { state: 'FAILED', canonicalErrorCode: 'CHANNEL_CAPABILITY_UNSUPPORTED', retrySafe: false });
});
