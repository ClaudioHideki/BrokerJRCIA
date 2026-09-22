import { describe, expect, it } from 'vitest';
import { createMessagingWorker } from '../../src/modules/messaging/worker.js';
import type { MessagingRepository } from '../../src/modules/messaging/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { AUTOMATION_ORIGIN } from '@jrc/contracts';

describe('composição do worker durável', () => {
  it('bounds each organization turn to one bot claim and one outbound claim', async () => {
    const turns: string[] = [];
    const repository = {
      async claimBotTurn(_tx: unknown, input: { organizationId: string }) { turns.push(`${input.organizationId}:bot`); return null; },
      async claimOutgoing(_tx: unknown, input: { organizationId: string; limit: number }) {
        expect(input.limit).toBe(1); turns.push(`${input.organizationId}:send`); return [];
      },
    } as unknown as MessagingRepository;
    const worker = createMessagingWorker({ repository,
      transact: (_org, operation) => operation({} as TenantTransaction),
      async resolveMetaClient() { throw new Error('unexpected'); },
      async resolveTypebotClient() { throw new Error('unexpected'); },
    });
    for (const organization of ['a','b','a','b']) await worker.runOnce(organization);
    expect(turns).toEqual(['a:bot','a:send','b:bot','b:send','a:bot','a:send','b:bot','b:send']);
  });
  it('executa Typebot fora da transação e persiste respostas antes de buscar saída', async () => {
    const events: string[] = [];
    let inTransaction = false;
    const repository = {
      async claimBotTurn() { return { message: { id: 'message', content: { type: 'TEXT', text: 'Oi' } }, conversation: { botPublicId: 'bot', botOriginReference: 'cloud', typebotSessionId: null } }; },
      async completeBotTurn(_tx: unknown, input: { texts: string[] }) { expect(inTransaction).toBe(true); events.push(...input.texts); },
      async claimOutgoing() { events.push('outbox'); return []; },
    } as unknown as MessagingRepository;
    const worker = createMessagingWorker({ repository,
      async transact(_org, operation) { inTransaction = true; try { return await operation({} as TenantTransaction); } finally { inTransaction = false; } },
      async resolveMetaClient() { throw new Error('unexpected Meta'); },
      async resolveTypebotClient() { expect(inTransaction).toBe(false); return {
        async startChat() { expect(inTransaction).toBe(false); return { sessionId: 'session', texts: ['Resposta'], incompatibilities: [] }; },
        async continueChat() { throw new Error('unexpected continuation'); },
      }; },
    });
    await worker.runOnce('tenant');
    expect(events).toEqual(['Resposta', 'outbox']);
  });
  it('encaminha mensagens do binding v2 uma única vez e conclui o lease do bot',async()=>{const events:string[]=[];const repository={
    async claimBotTurn(){return {message:{id:'message',organizationId:'tenant',content:{type:'TEXT',text:'Oi'}},channel:{id:'channel'},conversation:{id:'conversation',botPublicId:'automation',botOriginReference:AUTOMATION_ORIGIN,typebotSessionId:null}};},
    async completeBotTurn(){events.push('completed');return {kind:'completed',messages:[]};},async claimOutgoing(){return []},
  } as unknown as MessagingRepository;
    const worker=createMessagingWorker({repository,automations:{async route(_org,event){events.push(event.eventKey);}},transact:(_org,operation)=>operation({} as TenantTransaction),async resolveMetaClient(){throw new Error('unexpected')},async resolveTypebotClient(){throw new Error('unexpected')}});
    await worker.runOnce('tenant');expect(events).toEqual(['message:message','completed']);
  });
});
