import { describe, expect, it } from 'vitest';
import { runBotTurn, type BotTurnPorts } from '../../src/modules/messaging/bot-runner.js';

function harness(sessionId: string | null = null) {
  const results: unknown[] = [];
  const calls: string[] = [];
  const ports: BotTurnPorts = {
    async startChat(_id, text) { calls.push(`start:${text}`); return { sessionId: 'session', texts: ['Olá', 'Como posso ajudar?'], incompatibilities: [] }; },
    async continueChat(_id, text) { calls.push(`continue:${text}`); return { sessionId: 'session', texts: ['Resposta'], incompatibilities: [] }; },
    async complete(result) { results.push(result); },
    async fail(code, uncertain) { results.push({ code, uncertain }); },
  };
  return { ports, results, calls, turn: { publicId: 'bot', sessionId, text: 'Oi' } };
}
describe('execução Typebot', () => {
  it('inicia sessão e entrega respostas ordenadas para persistência atômica', async () => {
    const h = harness();
    await runBotTurn(h.turn, h.ports);
    expect(h.calls).toEqual(['start:Oi']);
    expect(h.results).toEqual([{ sessionId: 'session', texts: ['Olá', 'Como posso ajudar?'] }]);
  });
  it('continua sessão existente', async () => {
    const h = harness('session');
    await runBotTurn(h.turn, h.ports);
    expect(h.calls).toEqual(['continue:Oi']);
  });
  it('reinicia somente após expiração explícita', async () => {
    const h = harness('expired');
    h.ports.continueChat = async () => { throw Object.assign(new Error('SESSION_EXPIRED'), { code: 'SESSION_EXPIRED' }); };
    await runBotTurn(h.turn, h.ports);
    expect(h.calls).toEqual(['start:Oi']);
  });
  it('não repete chamada incerta nem envia saída incompatível', async () => {
    const h = harness();
    h.ports.startChat = async () => { throw new Error('secret upstream payload'); };
    await runBotTurn(h.turn, h.ports);
    expect(h.results).toEqual([{ code: 'TYPEBOT_TURN_UNKNOWN', uncertain: true }]);
    const bad = harness();
    bad.ports.startChat = async () => ({ sessionId: 'session', texts: ['partial'], incompatibilities: [{ kind: 'CLIENT_SIDE_ACTION', type: 'httpRequest' }] });
    await runBotTurn(bad.turn, bad.ports);
    expect(bad.results).toEqual([{ code: 'TYPEBOT_UNSUPPORTED_OUTPUT', uncertain: true }]);
  });
  it.each(['INVALID_CONFIGURATION', 'INVALID_ARGUMENT', 'UPSTREAM_ERROR'])(
    'classifica %s como falha definitiva sem efeito externo incerto',
    async code => {
      const h = harness();
      h.ports.startChat = async () => { throw Object.assign(new Error(code), { code }); };
      await runBotTurn(h.turn, h.ports);
      expect(h.results).toEqual([{ code: 'TYPEBOT_TURN_FAILED', uncertain: false }]);
    },
  );
  it.each(['UNKNOWN', 'INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'])(
    'classifica %s como resultado externo incerto',
    async code => {
      const h = harness();
      h.ports.startChat = async () => { throw Object.assign(new Error(code), { code }); };
      await runBotTurn(h.turn, h.ports);
      expect(h.results).toEqual([{ code: 'TYPEBOT_TURN_UNKNOWN', uncertain: true }]);
    },
  );
  it('deixa falha de commit propagar sem reiniciar a sessão', async () => {
    const h = harness();
    h.ports.complete = async () => { throw new Error('database unavailable'); };
    await expect(runBotTurn(h.turn, h.ports)).rejects.toThrow('database unavailable');
    expect(h.calls).toHaveLength(1);
    expect(h.results).toEqual([]);
  });
});
