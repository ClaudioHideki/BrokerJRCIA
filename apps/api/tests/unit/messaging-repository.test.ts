import { describe, expect, it } from 'vitest';

import {
  MessagingRepositoryError,
  canAdvanceMessageState,
  createPostgresMessagingRepository,
  isCustomerServiceWindowOpen,
} from '../../src/modules/messaging/repository.js';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import type { Message, MessageState } from '../../src/modules/messaging/types.js';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';

const MESSAGE: Message = {
  id: MESSAGE_ID,
  organizationId: ORGANIZATION_ID,
  channelId: CHANNEL_ID,
  conversationId: CONVERSATION_ID,
  direction: 'OUTGOING',
  source: 'AUTOMATION',
  upstreamMessageId: null,
  content: { type: 'TEXT', text: 'hello' },
  state: 'ACCEPTED',
  canonicalErrorCode: null,
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};

const CHANNEL = {
  id: CHANNEL_ID,
  organizationId: ORGANIZATION_ID,
  providerAccountId: '55555555-5555-4555-8555-555555555555',
  phoneNumberId: 'meta-phone-fixture',
  wabaId: 'meta-waba-fixture',
  credentialReference: 'vault://meta/fixture',
  botPublicId: 'bot-a',
  botOriginReference: 'origin-a',
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};

const CONTACT = {
  id: '66666666-6666-4666-8666-666666666666',
  organizationId: ORGANIZATION_ID,
  externalId: 'contact-fixture',
  displayName: 'Contact Fixture',
  consentStatus: 'OPTED_IN' as const,
  consentUpdatedAt: new Date('2030-01-01T00:00:00.000Z'),
  suppressedAt: null,
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};

const CONVERSATION = {
  id: CONVERSATION_ID,
  organizationId: ORGANIZATION_ID,
  channelId: CHANNEL_ID,
  contactId: CONTACT.id,
  mode: 'BOT' as const,
  botPublicId: 'bot-a',
  botOriginReference: 'origin-a',
  typebotSessionId: null,
  createdAt: new Date('2030-01-01T00:00:00.000Z'),
  updatedAt: new Date('2030-01-01T00:00:00.000Z'),
};

function transactionReturning(...rows: unknown[][]): TenantTransaction {
  let index = 0;
  return {
    async query(sql: string) {
      if (sql.includes('tenant_is_active')) return { rows: [{ active: true }], rowCount: 1 };
      const next = rows[index++] ?? [];
      return { rows: next, rowCount: next.length };
    },
  } as unknown as TenantTransaction;
}

describe('messaging state progression', () => {
  it.each<[MessageState, MessageState]>([
    ['ACCEPTED', 'SENDING'],
    ['SENDING', 'SENT'],
    ['SENT', 'DELIVERED'],
    ['DELIVERED', 'READ'],
    ['UNKNOWN', 'SENT'],
    ['UNKNOWN', 'DELIVERED'],
  ])('permite avanço de %s para %s', (from, to) => {
    expect(canAdvanceMessageState(from, to)).toBe(true);
  });

  it.each<[MessageState, MessageState]>([
    ['READ', 'DELIVERED'],
    ['DELIVERED', 'SENT'],
    ['SENT', 'SENDING'],
    ['FAILED', 'SENDING'],
  ])('impede regressão de %s para %s', (from, to) => {
    expect(canAdvanceMessageState(from, to)).toBe(false);
  });

  it('trata a repetição do mesmo estado como idempotente', () => {
    expect(canAdvanceMessageState('DELIVERED', 'DELIVERED')).toBe(true);
  });
});

describe('Meta customer service window', () => {
  const now = new Date('2030-01-02T00:00:00.000Z');

  it('accepts an incoming event strictly inside the prior 24 hours', () => {
    expect(isCustomerServiceWindowOpen(new Date('2030-01-01T00:00:00.001Z'), now)).toBe(true);
  });

  it('rejects the exact 24-hour boundary, future events, and absent history', () => {
    expect(isCustomerServiceWindowOpen(new Date('2030-01-01T00:00:00.000Z'), now)).toBe(false);
    expect(isCustomerServiceWindowOpen(new Date('2030-01-02T00:00:00.001Z'), now)).toBe(false);
    expect(isCustomerServiceWindowOpen(null, now)).toBe(false);
  });
});

describe('PostgresMessagingRepository idempotency behavior', () => {
  it('reproduz a mensagem existente quando chave e hash coincidem', async () => {
    const transaction = transactionReturning([{
      ...MESSAGE,
      idempotencyBodyHash: 'same-hash',
    }]);

    const result = await createPostgresMessagingRepository().enqueueOutgoing(transaction, {
      id: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID,
      source: 'AUTOMATION',
      content: { type: 'TEXT', text: 'hello' },
      idempotencyKey: 'request-1',
      bodyHash: 'same-hash',
      policy: { requireOptIn: true },
    });

    expect(result).toEqual({ kind: 'replayed', message: MESSAGE });
  });

  it('rejeita reutilização da chave com corpo diferente', async () => {
    const transaction = transactionReturning([{
      ...MESSAGE,
      idempotencyBodyHash: 'first-hash',
    }]);

    const promise = createPostgresMessagingRepository().enqueueOutgoing(transaction, {
      id: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID,
      source: 'OPERATOR',
      content: { type: 'TEXT', text: 'changed' },
      idempotencyKey: 'request-1',
      bodyHash: 'different-hash',
      policy: { requireOptIn: false },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    } satisfies Partial<MessagingRepositoryError>);
  });

  it('persiste mensagem e outbox quando contato consentiu', async () => {
    const transaction = transactionReturning(
      [],
      [{ consentStatus: 'OPTED_IN', suppressedAt: null, mode: 'BOT' }],
      [MESSAGE],
    );

    const result = await createPostgresMessagingRepository().enqueueOutgoing(transaction, {
      id: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID,
      source: 'AUTOMATION',
      content: { type: 'TEXT', text: 'hello' },
      idempotencyKey: 'request-2',
      bodyHash: 'body-hash',
      policy: { requireOptIn: true },
    });

    expect(result).toEqual({ kind: 'created', message: MESSAGE });
  });

  it.each([
    {
      policy: { consentStatus: 'OPTED_IN', suppressedAt: new Date('2030-01-01'), mode: 'BOT' },
      source: 'OPERATOR' as const,
      code: 'CONTACT_SUPPRESSED',
    },
    {
      policy: { consentStatus: 'UNKNOWN', suppressedAt: null, mode: 'BOT' },
      source: 'OPERATOR' as const,
      code: 'CONTACT_CONSENT_REQUIRED',
    },
    {
      policy: { consentStatus: 'OPTED_IN', suppressedAt: null, mode: 'HUMAN' },
      source: 'AUTOMATION' as const,
      code: 'CONVERSATION_PAUSED',
    },
  ])('rejeita enqueue por $code', async ({ policy, source, code }) => {
    const transaction = transactionReturning([], [policy]);

    const promise = createPostgresMessagingRepository().enqueueOutgoing(transaction, {
      id: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID,
      source,
      content: { type: 'TEXT', text: 'hello' },
      idempotencyKey: `request-${code}`,
      bodyHash: 'body-hash',
      policy: { requireOptIn: true },
    });

    await expect(promise).rejects.toMatchObject({ code, status: 422 });
  });

  it('rejeita OPTED_OUT mesmo quando texto não exige opt-in explícito', async () => {
    const transaction = transactionReturning([], [{
      consentStatus: 'OPTED_OUT', suppressedAt: null, mode: 'BOT',
    }]);
    await expect(createPostgresMessagingRepository().enqueueOutgoing(transaction, {
      id: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID,
      source: 'AUTOMATION',
      content: { type: 'TEXT', text: 'hello' },
      idempotencyKey: 'request-opted-out-text',
      bodyHash: 'body-hash',
      policy: { requireOptIn: false },
    })).rejects.toMatchObject({ code: 'CONTACT_CONSENT_REQUIRED', status: 422 });
  });
});

describe('PostgresMessagingRepository webhook dedupe', () => {
  it('vincula evento novo à mensagem recebida durável', async () => {
    const incoming = {
      ...MESSAGE,
      direction: 'INCOMING' as const,
      source: 'CONTACT' as const,
      upstreamMessageId: 'wamid.incoming',
      state: 'DELIVERED' as const,
    };
    const transaction = transactionReturning([{ id: 'event-id' }], [incoming], [], [{ scheduled: true }]);

    const result = await createPostgresMessagingRepository().recordIncoming(transaction, {
      id: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID,
      webhookEventKey: 'event-new',
      upstreamMessageId: 'wamid.incoming',
      content: { type: 'TEXT', text: 'hello' },
    });

    expect(result).toEqual({ kind: 'created', message: incoming, botScheduled: true });
  });

  it('retorna a mensagem durável para repetição do mesmo evento', async () => {
    const incoming = {
      ...MESSAGE,
      direction: 'INCOMING' as const,
      source: 'CONTACT' as const,
      upstreamMessageId: 'wamid.incoming',
      state: 'DELIVERED' as const,
    };
    const transaction = transactionReturning([], [incoming]);

    const result = await createPostgresMessagingRepository().recordIncoming(transaction, {
      id: MESSAGE_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      conversationId: CONVERSATION_ID,
      webhookEventKey: 'event-1',
      upstreamMessageId: 'wamid.incoming',
      content: { type: 'TEXT', text: 'hello' },
    });

    expect(result).toEqual({ kind: 'duplicate', message: incoming, botScheduled: false });
  });
});

describe('PostgresMessagingRepository early provider statuses', () => {
  it('persists a status that arrives before the outgoing message is linked', async () => {
    const transaction = transactionReturning([], [{ id: 'status-event-id' }], []);
    await expect(createPostgresMessagingRepository().recordStatusEvent(transaction, {
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      upstreamMessageId: 'wamid.early',
      state: 'DELIVERED',
    })).resolves.toEqual({ kind: 'recorded', message: null });
  });

  it('advances a known message monotonically', async () => {
    const delivered = { ...MESSAGE, state: 'DELIVERED' as const, upstreamMessageId: 'wamid.known' };
    const transaction = transactionReturning(
      [],
      [{ id: 'status-event-id' }],
      [{ ...MESSAGE, state: 'SENT' }],
      [delivered],
    );
    await expect(createPostgresMessagingRepository().recordStatusEvent(transaction, {
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      upstreamMessageId: 'wamid.known',
      state: 'DELIVERED',
    })).resolves.toEqual({ kind: 'recorded', message: delivered });
  });
});

describe('PostgresMessagingRepository bot ownership', () => {
  it('permite continuar a sessão do mesmo bot', async () => {
    const updated = { ...CONVERSATION, typebotSessionId: 'session-a' };
    const transaction = transactionReturning([updated]);

    await expect(createPostgresMessagingRepository().bindTypebotSession(transaction, {
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
      botPublicId: 'bot-a',
      botOriginReference: 'origin-a',
      typebotSessionId: 'session-a',
    })).resolves.toEqual(updated);
  });

  it('impede trocar o bot que já possui a sessão da conversa', async () => {
    const transaction = transactionReturning([], [{
      botPublicId: 'bot-a',
      botOriginReference: 'origin-a',
    }]);

    const promise = createPostgresMessagingRepository().bindTypebotSession(transaction, {
      organizationId: ORGANIZATION_ID,
      conversationId: CONVERSATION_ID,
      botPublicId: 'bot-b',
      botOriginReference: 'origin-b',
      typebotSessionId: 'session-b',
    });

    await expect(promise).rejects.toMatchObject({
      code: 'BOT_OWNERSHIP_CONFLICT',
      status: 409,
    });
  });
});

describe('PostgresMessagingRepository panel and provisioning operations', () => {
  it('retorna os recursos persistidos por organização', async () => {
    const repository = createPostgresMessagingRepository();
    await expect(repository.createChannel(transactionReturning([CHANNEL]), {
      id: CHANNEL.id,
      organizationId: ORGANIZATION_ID,
      providerAccountId: CHANNEL.providerAccountId,
      phoneNumberId: CHANNEL.phoneNumberId,
      wabaId: CHANNEL.wabaId,
      credentialReference: CHANNEL.credentialReference,
      botPublicId: CHANNEL.botPublicId,
      botOriginReference: CHANNEL.botOriginReference,
    })).resolves.toEqual(CHANNEL);
    await expect(repository.listChannels(transactionReturning([[CHANNEL][0]]), ORGANIZATION_ID))
      .resolves.toEqual([CHANNEL]);
    await expect(repository.findChannel(transactionReturning([CHANNEL]), ORGANIZATION_ID, CHANNEL_ID))
      .resolves.toEqual(CHANNEL);
    await expect(repository.upsertContact(transactionReturning([CONTACT]), {
      id: CONTACT.id,
      organizationId: ORGANIZATION_ID,
      externalId: CONTACT.externalId,
      displayName: CONTACT.displayName,
      consentStatus: CONTACT.consentStatus,
      consentUpdatedAt: CONTACT.consentUpdatedAt,
    })).resolves.toEqual(CONTACT);
    await expect(repository.getOrCreateConversation(transactionReturning([CONVERSATION]), {
      id: CONVERSATION_ID,
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      contactId: CONTACT.id,
    })).resolves.toEqual(CONVERSATION);
    await expect(repository.findConversation(
      transactionReturning([CONVERSATION]), ORGANIZATION_ID, CONVERSATION_ID,
    )).resolves.toEqual(CONVERSATION);
    await expect(repository.listConversationMessages(
      transactionReturning([MESSAGE]), ORGANIZATION_ID, CONVERSATION_ID, 20,
    )).resolves.toEqual([MESSAGE]);
    await expect(repository.findMessageByUpstream(transactionReturning([MESSAGE]), {
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      upstreamMessageId: 'wamid.fixture',
    })).resolves.toEqual(MESSAGE);
  });

  it('rebinds a channel bot and returns the updated channel', async () => {
    const rebound = { ...CHANNEL, botPublicId: 'bot-b', botOriginReference: 'origin-b' };
    const transaction = transactionReturning([], [], [CHANNEL], [rebound], [], []);
    await expect(createPostgresMessagingRepository().setChannelBot(transaction, {
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      botPublicId: 'bot-b',
      botOriginReference: 'origin-b',
    })).resolves.toEqual(rebound);
  });

  it('rejects a partial bot binding', async () => {
    await expect(createPostgresMessagingRepository().setChannelBot(transactionReturning(), {
      organizationId: ORGANIZATION_ID,
      channelId: CHANNEL_ID,
      botPublicId: 'bot-b',
      botOriginReference: null,
    })).rejects.toMatchObject({ code: 'INVALID_BOT_CONFIGURATION', status: 422 });
  });
});

describe('PostgresMessagingRepository outbox lifecycle', () => {
  const CLAIM = {
    message: MESSAGE,
    contact: CONTACT,
    channel: CHANNEL,
    leaseToken: '77777777-7777-4777-8777-777777777777',
    attemptCount: 1,
  };

  it('devolve somente os itens adquiridos pelo worker', async () => {
    const transaction = transactionReturning([], [], [], [], [CLAIM]);
    await expect(createPostgresMessagingRepository().claimOutgoing(transaction, {
      organizationId: ORGANIZATION_ID,
      workerId: CLAIM.leaseToken,
      now: new Date('2030-01-01T00:00:00.000Z'),
      leaseMs: 30_000,
      limit: 10,
    })).resolves.toEqual([CLAIM]);
  });

  it('muda para SENDING somente na revalidação imediatamente anterior ao HTTP', async () => {
    const sendingMessage = { ...MESSAGE, state: 'SENDING' as const };
    const sendingClaim = { ...CLAIM, message: sendingMessage };
    const transaction = transactionReturning([{
      ...CLAIM,
      requiresOptIn: true,
      consentStatus: 'OPTED_IN',
      suppressedAt: null,
      mode: 'BOT',
      customerServiceWindowOpen: true,
    }], [sendingMessage]);

    await expect(createPostgresMessagingRepository().validateClaim(transaction, {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: CLAIM.leaseToken,
    })).resolves.toEqual({ eligible: true, claim: sendingClaim });
  });

  it('falha claim de texto quando contato revoga consentimento antes do HTTP', async () => {
    const transaction = transactionReturning([{
      ...CLAIM,
      contact: { ...CONTACT, consentStatus: 'OPTED_OUT' },
      requiresOptIn: false,
      mode: 'BOT',
      customerServiceWindowOpen: true,
    }], []);

    await expect(createPostgresMessagingRepository().validateClaim(transaction, {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: CLAIM.leaseToken,
    })).resolves.toEqual({ eligible: false, reason: 'CONTACT_CONSENT_REQUIRED' });
  });

  it('não completa envio sem possuir o lease', async () => {
    const promise = createPostgresMessagingRepository().completeSend(transactionReturning([]), {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: CLAIM.leaseToken,
      outcome: { state: 'SENT', upstreamMessageId: 'wamid.sent' },
    });
    await expect(promise).rejects.toMatchObject({ code: 'INVALID_OUTBOX_CLAIM', status: 409 });
  });

  it('reconcilia status que chegou antes da resposta de envio', async () => {
    const sent = { ...MESSAGE, state: 'SENT' as const, upstreamMessageId: 'wamid.early' };
    const read = { ...MESSAGE, state: 'READ' as const, upstreamMessageId: 'wamid.early' };
    const transaction = transactionReturning(
      [{ channelId: CHANNEL_ID }],
      [],
      [{ ...MESSAGE, state: 'SENDING' }],
      [sent],
      [{ state: 'DELIVERED' }, { state: 'READ' }],
      [read],
      [],
    );
    await expect(createPostgresMessagingRepository().completeSend(transaction, {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: CLAIM.leaseToken,
      outcome: { state: 'SENT', upstreamMessageId: 'wamid.early' },
    })).resolves.toEqual(read);
  });

  it('persiste falha de preflight com lease ainda ACCEPTED', async () => {
    const failed = {
      ...MESSAGE,
      state: 'FAILED' as const,
      canonicalErrorCode: 'META_TEMPLATE_NOT_APPROVED',
    };
    const transaction = transactionReturning(
      [MESSAGE],
      [failed],
      [],
    );
    await expect(createPostgresMessagingRepository().completeSend(transaction, {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: CLAIM.leaseToken,
      outcome: {
        state: 'FAILED',
        canonicalErrorCode: 'META_TEMPLATE_NOT_APPROVED',
        retrySafe: false,
      },
    })).resolves.toEqual(failed);
  });

  it('permite retry explícito somente da falha marcada segura', async () => {
    const retried = { ...MESSAGE, state: 'ACCEPTED' as const };
    await expect(createPostgresMessagingRepository().retrySafeFailure(transactionReturning([retried]), {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      notBefore: new Date('2030-01-01T00:01:00.000Z'),
    })).resolves.toEqual(retried);

    await expect(createPostgresMessagingRepository().retrySafeFailure(transactionReturning([]), {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      notBefore: new Date('2030-01-01T00:01:00.000Z'),
    })).rejects.toMatchObject({ code: 'INVALID_MESSAGE_TRANSITION', status: 409 });
  });
});

describe('PostgresMessagingRepository bot turn lifecycle', () => {
  const BOT_CLAIM = {
    message: { ...MESSAGE, direction: 'INCOMING' as const, source: 'CONTACT' as const, state: 'DELIVERED' as const },
    conversation: CONVERSATION,
    contact: CONTACT,
    channel: CHANNEL,
    leaseToken: '88888888-8888-4888-8888-888888888888',
  };

  it('claims the oldest eligible incoming turn', async () => {
    const transaction = transactionReturning([], [], [], [BOT_CLAIM]);
    await expect(createPostgresMessagingRepository().claimBotTurn(transaction, {
      organizationId: ORGANIZATION_ID,
      workerId: BOT_CLAIM.leaseToken,
      now: new Date('2030-01-01T00:00:00.000Z'),
      leaseMs: 30_000,
    })).resolves.toEqual(BOT_CLAIM);
  });

  it('cancels generated output when a human took over', async () => {
    const transaction = transactionReturning([{
      mode: 'HUMAN', suppressedAt: null, consentStatus: 'OPTED_IN',
      incomingOccurredAt: new Date('2030-01-01T00:00:00.000Z'),
    }], []);
    await expect(createPostgresMessagingRepository().completeBotTurn(transaction, {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: BOT_CLAIM.leaseToken,
      sessionId: 'session-a',
      texts: ['must not enqueue'],
      now: new Date('2030-01-01T00:01:00.000Z'),
    })).resolves.toEqual({ kind: 'paused', messages: [] });
  });

  it('marks uncertain Typebot processing UNKNOWN without retry', async () => {
    const transaction = transactionReturning([{ messageId: MESSAGE_ID }]);
    await expect(createPostgresMessagingRepository().failBotTurn(transaction, {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: BOT_CLAIM.leaseToken,
      canonicalErrorCode: 'TYPEBOT_TIMEOUT',
    })).resolves.toBe('UNKNOWN');
  });

  it('marks a failure before external I/O as FAILED', async () => {
    const transaction = transactionReturning([{ messageId: MESSAGE_ID }]);
    await expect(createPostgresMessagingRepository().failBotTurn(transaction, {
      organizationId: ORGANIZATION_ID,
      messageId: MESSAGE_ID,
      leaseToken: BOT_CLAIM.leaseToken,
      canonicalErrorCode: 'TYPEBOT_NOT_CONFIGURED',
      uncertain: false,
    })).resolves.toBe('FAILED');
  });
});
