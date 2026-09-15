import { describe, expect, it } from 'vitest';
import { normalizeQrEvent } from '../../src/modules/messaging/qr-events.js';

const envelope = (data: unknown, event = 'messages.upsert') => ({ event, instance: 'jrc-private-instance', data });
const message = { key: { id: 'qr-message-1', remoteJid: '15550000001@s.whatsapp.net', fromMe: false }, messageTimestamp: 1789470000, pushName: 'Contato de teste', message: { conversation: 'Olá JRC' } };
describe('eventos QR canônicos', () => {
  it('normaliza conexão e desconexão do canal',()=>{
    expect(normalizeQrEvent(envelope({state:'open'},'connection.update'),'jrc-private-instance')).toEqual([{kind:'connection',state:'CONNECTED'}]);
    expect(normalizeQrEvent(envelope({state:'close'},'connection.update'),'jrc-private-instance')).toEqual([{kind:'connection',state:'DISCONNECTED'}]);
  });
  it('normaliza texto e número sem aceitar empresa informada pelo remetente', () => {
    expect(normalizeQrEvent({ ...envelope(message), organizationId: 'attacker' }, 'jrc-private-instance')).toEqual([
      { kind: 'message', upstreamMessageId: 'qr-message-1', externalId: '15550000001', displayName: 'Contato de teste', content: { type: 'TEXT', text: 'Olá JRC' }, occurredAt: new Date(1789470000000) },
    ]);
  });
  it('recusa evento de outra instância', () => {
    expect(() => normalizeQrEvent(envelope(message), 'other-instance')).toThrow('QR_INSTANCE_MISMATCH');
  });
  it('ignora ecos, grupos e históricos sem disparar atendimento', () => {
    expect(normalizeQrEvent(envelope({ ...message, key: { ...message.key, fromMe: true } }), 'jrc-private-instance')).toEqual([]);
    expect(normalizeQrEvent(envelope({ ...message, key: { ...message.key, remoteJid: 'group@g.us' } }), 'jrc-private-instance')).toEqual([]);
    expect(normalizeQrEvent(envelope(message, 'messages.set'), 'jrc-private-instance')).toEqual([]);
  });
  it('usa número alternativo validado quando o evento usa LID', () => {
    const value = { ...message, key: { ...message.key, remoteJid: '123@lid', remoteJidAlt: '15550000002@s.whatsapp.net' } };
    expect(normalizeQrEvent(envelope(value), 'jrc-private-instance')[0]).toMatchObject({ externalId: '15550000002' });
  });
  it('normaliza estado entregue e rejeita timestamps inválidos', () => {
    expect(normalizeQrEvent(envelope({ keyId: 'qr-message-1', status: 'DELIVERY_ACK' }, 'messages.update'), 'jrc-private-instance')[0]).toMatchObject({ kind: 'status', upstreamMessageId: 'qr-message-1', state: 'DELIVERED' });
    expect(() => normalizeQrEvent(envelope({ ...message, messageTimestamp: -1 }), 'jrc-private-instance')).toThrow('QR_EVENT_INVALID');
  });
});
