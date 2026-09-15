import { describe, expect, it } from 'vitest';

import { dispatchClaim, type DispatchPorts } from '../../src/modules/messaging/dispatcher.js';
import type {
  CompleteSendOutcome,
  MessageContent,
  OutboxClaim,
} from '../../src/modules/messaging/types.js';

type DispatchClient = Awaited<ReturnType<DispatchPorts['resolveClient']>>;

const textClaim = makeClaim({ type: 'TEXT', text: 'Resposta de teste' });

function makeClaim(content: MessageContent): OutboxClaim {
  return {
    message: { id: 'message', organizationId: 'tenant', content },
    channel: { id: 'channel' },
    contact: { externalId: '15550000000' },
    leaseToken: 'lease',
    attemptCount: 1,
  } as OutboxClaim;
}

function harness(options: {
  client?: Partial<DispatchClient>;
  ports?: Partial<DispatchPorts>;
} = {}) {
  const outcomes: CompleteSendOutcome[] = [];
  const requests: Array<
    | { type: 'TEXT'; text: string }
    | { type: 'TEMPLATE'; template: Parameters<DispatchClient['sendTemplate']>[1] }
  > = [];
  const events: string[] = [];
  const client: DispatchClient = {
    async sendText(_to, text) {
      events.push('send');
      requests.push({ type: 'TEXT', text });
      return { status: 'ACCEPTED', upstreamMessageId: 'wamid.synthetic' };
    },
    async sendTemplate(_to, template) {
      events.push('send');
      requests.push({ type: 'TEMPLATE', template });
      return { status: 'ACCEPTED', upstreamMessageId: 'wamid.synthetic' };
    },
    async listTemplates() {
      events.push('list');
      return [];
    },
    ...options.client,
  };
  const ports: DispatchPorts = {
    async validate() {
      events.push('validate');
      return true;
    },
    async resolveClient() {
      events.push('resolve');
      return client;
    },
    async complete(_claim, outcome) {
      events.push('complete');
      outcomes.push(outcome);
    },
    ...options.ports,
  };
  return { client, events, outcomes, ports, requests };
}

describe('despacho de mensagens', () => {
  it('finishes a claim safely when revoked credentials cannot be resolved', async () => {
    const h=harness({ports:{async resolveClient(){throw new Error('private-token-do-not-log');}}});
    await dispatchClaim(textClaim,h.ports);
    expect(h.requests).toEqual([]);
    expect(h.outcomes).toEqual([{state:'FAILED',canonicalErrorCode:'META_CREDENTIAL_UNAVAILABLE',retrySafe:false}]);
  });
  it('rechecks revocation after a deferred template lookup before any POST', async () => {
    let release!:()=>void;let entered!:()=>void;let revoked=false;
    const pending=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
    const h=harness({ports:{async validate(){return !revoked;}},client:{async listTemplates(){entered();await pending;return [{id:'12345',name:'hello',language:'pt_BR',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'hello'}]}];}}});
    const dispatch=dispatchClaim(makeClaim({type:'TEMPLATE',name:'hello',language:'pt_BR',variables:[]}),h.ports);
    await started;revoked=true;release();await dispatch;
    expect(h.requests).toEqual([]);
  });
  it('registra aceitação do provider como SENT, sem afirmar entrega', async () => {
    const h = harness();

    await dispatchClaim(textClaim, h.ports);

    expect(h.requests).toEqual([{ type: 'TEXT', text: 'Resposta de teste' }]);
    expect(h.outcomes).toEqual([{ state: 'SENT', upstreamMessageId: 'wamid.synthetic' }]);
    expect(h.events).toEqual(['resolve', 'validate', 'send', 'complete']);
  });

  it('não envia quando consentimento, pausa ou lease são invalidados', async () => {
    const h = harness({ ports: { async validate() { return false; } } });

    await dispatchClaim(textClaim, h.ports);

    expect(h.requests).toEqual([]);
    expect(h.outcomes).toEqual([]);
  });

  it('não repete envio após resultado incerto e persiste UNKNOWN', async () => {
    let attempts = 0;
    const h = harness({
      client: {
        async sendText() {
          attempts += 1;
          throw Object.assign(new Error('sensitive body'), { code: 'META_SEND_UNKNOWN' });
        },
      },
    });

    await dispatchClaim(textClaim, h.ports);

    expect(attempts).toBe(1);
    expect(h.outcomes).toEqual([{
      state: 'UNKNOWN',
      canonicalErrorCode: 'META_SEND_UNKNOWN',
    }]);
  });

  it('não transforma falha de persistência após envio em nova tentativa', async () => {
    const h = harness({
      ports: { async complete() { throw new Error('storage unavailable'); } },
    });

    await expect(dispatchClaim(textClaim, h.ports)).rejects.toThrow('storage unavailable');
    expect(h.requests).toHaveLength(1);
  });

  it.each(['PAUSED', 'REJECTED'])('recusa template com estado Meta %s', async (status) => {
    const h = harness({
      client: {
        async listTemplates() {
          return [{
            id: '10001',
            name: 'pedido_pronto',
            language: 'pt_BR',
            status,
            category: 'UTILITY',
            components: [{ type: 'BODY', text: 'Pedido {{1}} pronto' }],
          }];
        },
      },
    });

    await dispatchClaim(makeClaim({
      type: 'TEMPLATE',
      name: 'pedido_pronto',
      language: 'pt_BR',
      variables: ['42'],
    }), h.ports);

    expect(h.requests).toEqual([]);
    expect(h.outcomes).toEqual([{
      state: 'FAILED',
      canonicalErrorCode: 'META_TEMPLATE_NOT_APPROVED',
      retrySafe: false,
    }]);
  });

  it('recusa template que não pertence ao WABA configurado', async () => {
    const h = harness();

    await dispatchClaim(makeClaim({
      type: 'TEMPLATE',
      name: 'template_inexistente',
      language: 'pt_BR',
      variables: [],
    }), h.ports);

    expect(h.requests).toEqual([]);
    expect(h.outcomes).toEqual([{
      state: 'FAILED',
      canonicalErrorCode: 'META_TEMPLATE_NOT_APPROVED',
      retrySafe: false,
    }]);
  });

  it('envia template aprovado com variáveis posicionais somente no corpo', async () => {
    const h = harness({
      client: {
        async listTemplates() {
          h.events.push('list');
          return [{
            id: '10001',
            name: 'pedido_pronto',
            language: 'pt_BR',
            status: 'APPROVED',
            category: 'UTILITY',
            components: [
              { type: 'HEADER', format: 'TEXT', text: 'Atualização do pedido' },
              { type: 'BODY', text: 'Olá {{1}}, o pedido {{2}} está pronto.' },
              { type: 'FOOTER', text: 'JRC' },
            ],
          }];
        },
      },
    });

    await dispatchClaim(makeClaim({
      type: 'TEMPLATE',
      name: 'pedido_pronto',
      language: 'pt_BR',
      variables: ['Ana', '42'],
    }), h.ports);

    expect(h.requests).toEqual([{
      type: 'TEMPLATE',
      template: {
        name: 'pedido_pronto',
        language: 'pt_BR',
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: 'Ana' },
            { type: 'text', text: '42' },
          ],
        }],
      },
    }]);
    expect(h.outcomes).toEqual([{ state: 'SENT', upstreamMessageId: 'wamid.synthetic' }]);
    expect(h.events).toEqual(['resolve', 'list', 'validate', 'send', 'complete']);
  });

  it.each([
    ['missing variable', 'Olá {{1}}, pedido {{2}}.', ['Ana']],
    ['extra variable', 'Olá {{1}}.', ['Ana', '42']],
    ['non-contiguous position', 'Olá {{1}}, pedido {{3}}.', ['Ana', '42', 'pronto']],
    [
      'more variables than the public request accepts',
      Array.from({ length: 101 }, (_, index) => `{{${index + 1}}}`).join(' '),
      Array.from({ length: 101 }, () => 'x'),
    ],
  ])('recusa template com %s', async (_case, body, variables) => {
    const h = harness({
      client: {
        async listTemplates() {
          return [{
            id: '10001',
            name: 'pedido_pronto',
            language: 'pt_BR',
            status: 'APPROVED',
            category: 'UTILITY',
            components: [{ type: 'BODY', text: body }],
          }];
        },
      },
    });

    await dispatchClaim(makeClaim({
      type: 'TEMPLATE',
      name: 'pedido_pronto',
      language: 'pt_BR',
      variables,
    }), h.ports);

    expect(h.requests).toEqual([]);
    expect(h.outcomes).toEqual([{
      state: 'FAILED',
      canonicalErrorCode: 'META_TEMPLATE_VARIABLE_MISMATCH',
      retrySafe: false,
    }]);
  });

  it.each([
    ['media header', [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Olá' }]],
    ['dynamic header', [{ type: 'HEADER', format: 'TEXT', text: 'Olá {{1}}' }, { type: 'BODY', text: 'Pedido pronto' }]],
    ['dynamic button', [{ type: 'BODY', text: 'Pedido pronto' }, {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Abrir', url: 'https://example.com/{{1}}' }],
    }]],
    ['named dynamic button', [{ type: 'BODY', text: 'Pedido pronto' }, {
      type: 'BUTTONS',
      buttons: [{ type: 'URL', text: 'Abrir', url: 'https://example.com/{{slug}}' }],
    }]],
    ['named body variable', [{ type: 'BODY', text: 'Olá {{customer_name}}' }]],
    ['missing body', [{ type: 'FOOTER', text: 'JRC' }]],
    ['unknown component', [{ type: 'CAROUSEL', cards: [] }, { type: 'BODY', text: 'Olá' }]],
  ])('recusa componente ainda não implementado: %s', async (_case, components) => {
    const h = harness({
      client: {
        async listTemplates() {
          return [{
            id: '10001',
            name: 'pedido_pronto',
            language: 'pt_BR',
            status: 'APPROVED',
            category: 'UTILITY',
            components,
          }];
        },
      },
    });

    await dispatchClaim(makeClaim({
      type: 'TEMPLATE',
      name: 'pedido_pronto',
      language: 'pt_BR',
      variables: [],
    }), h.ports);

    expect(h.requests).toEqual([]);
    expect(h.outcomes).toEqual([{
      state: 'FAILED',
      canonicalErrorCode: 'META_TEMPLATE_UNSUPPORTED_COMPONENTS',
      retrySafe: false,
    }]);
  });

  it('revalida lease e política depois do lookup e imediatamente antes do envio', async () => {
    let stillEligible = true;
    const h = harness({
      client: {
        async listTemplates() {
          h.events.push('list');
          stillEligible = false;
          return [{
            id: '10001',
            name: 'sem_variaveis',
            language: 'pt_BR',
            status: 'APPROVED',
            category: 'UTILITY',
            components: [{ type: 'BODY', text: 'Mensagem fixa' }],
          }];
        },
      },
      ports: {
        async validate() {
          h.events.push('validate');
          return stillEligible;
        },
      },
    });

    await dispatchClaim(makeClaim({
      type: 'TEMPLATE',
      name: 'sem_variaveis',
      language: 'pt_BR',
      variables: [],
    }), h.ports);

    expect(h.events).toEqual(['resolve', 'list', 'validate']);
    expect(h.requests).toEqual([]);
    expect(h.outcomes).toEqual([]);
  });
});
