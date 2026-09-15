import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createOwnerMembership } from '../../src/modules/memberships/repository.js';
import { createOrganization, runInAdminTransaction } from '../../src/modules/organizations/repository.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import { createUser } from '../../src/modules/users/repository.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import {
  createIsolatedPostgresDatabase,
  type IsolatedPostgresDatabase,
  oneRow,
  requireTestDatabaseAdminUrl,
} from './helpers/postgres.js';
import { connectionStringForRole } from './helpers/task7.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

describe('durable tenant messaging storage', () => {
  let database: IsolatedPostgresDatabase;
  let appPool: Pool;
  let organizationA: string;
  let organizationB: string;
  let providerA: string;
  let providerB: string;
  let channelA: string;
  let channelB: string;
  let contactA: string;
  let conversationA: string;
  const repository = createPostgresMessagingRepository();

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, async () => runMigrations(database.connectionString));
    await runInAdminTransaction(database.pool, async (transaction) => {
      organizationA = (await createOrganization(transaction, { name: 'Messaging A', slug: 'messaging-a' })).id;
      organizationB = (await createOrganization(transaction, { name: 'Messaging B', slug: 'messaging-b' })).id;
      const ownerA = await createUser(transaction, {
        email: 'messaging-owner-a@example.test', passwordHash: 'argon2id-test-hash',
      });
      const ownerB = await createUser(transaction, {
        email: 'messaging-owner-b@example.test', passwordHash: 'argon2id-test-hash',
      });
      await createOwnerMembership(transaction, { organizationId: organizationA, userId: ownerA.id });
      await createOwnerMembership(transaction, { organizationId: organizationB, userId: ownerB.id });
    });
    appPool = new Pool({ connectionString: connectionStringForRole(database.connectionString, 'jrc_app'), max: 6 });
    providerA = await withOrganizationTransaction(appPool, organizationA, async (transaction) => (
      (await transaction.query<{ id: string }>(
        `INSERT INTO provider_accounts
           (organization_id, provider, name, credential_reference)
         VALUES ($1, 'META', 'meta-a', 'vault://meta/a') RETURNING id`,
        [organizationA],
      )).rows[0]!.id
    ));
    providerB = await withOrganizationTransaction(appPool, organizationB, async (transaction) => (
      (await transaction.query<{ id: string }>(
        `INSERT INTO provider_accounts
           (organization_id, provider, name, credential_reference)
         VALUES ($1, 'META', 'meta-b', 'vault://meta/b') RETURNING id`,
        [organizationB],
      )).rows[0]!.id
    ));
    const channelARow = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.createChannel(transaction, {
        id: randomUUID(), organizationId: organizationA, providerAccountId: providerA,
        phoneNumberId: 'meta-phone-a', wabaId: 'meta-waba-a', credentialReference: 'vault://meta/a',
        botPublicId: 'support-bot', botOriginReference: 'typebot-origin-primary',
      })
    ));
    const channelBRow = await withOrganizationTransaction(appPool, organizationB, (transaction) => (
      repository.createChannel(transaction, {
        id: randomUUID(), organizationId: organizationB, providerAccountId: providerB,
        phoneNumberId: 'meta-phone-b', wabaId: 'meta-waba-b', credentialReference: 'vault://meta/b',
        botPublicId: null, botOriginReference: null,
      })
    ));
    channelA = channelARow.id;
    channelB = channelBRow.id;
    const contact = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.upsertContact(transaction, {
        id: randomUUID(), organizationId: organizationA, externalId: 'contact-fixture-a',
        displayName: 'Fixture A', consentStatus: 'OPTED_IN', consentUpdatedAt: new Date(),
      })
    ));
    contactA = contact.id;
    conversationA = (await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.getOrCreateConversation(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA, contactId: contactA,
      })
    ))).id;
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await database?.dispose();
  });

  it('aplica RLS e chaves compostas entre tenant em todas as relações', async () => {
    await expect(withOrganizationTransaction(appPool, organizationB, (transaction) => (
      repository.findChannel(transaction, organizationB, channelA)
    ))).resolves.toBeNull();
    await expect(withOrganizationTransaction(appPool, organizationB, (transaction) => (
      repository.listChannels(transaction, organizationB)
    ))).resolves.toMatchObject([{ id: channelB }]);
    await expect(withOrganizationTransaction(appPool, organizationB, (transaction) => (
      repository.getOrCreateConversation(transaction, {
        id: randomUUID(), organizationId: organizationB, channelId: channelA, contactId: contactA,
      })
    ))).rejects.toBeDefined();

    const tables = await database.pool.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname LIKE 'messaging_%' AND relkind = 'r'`,
    );
    expect(tables.rows).not.toHaveLength(0);
    expect(tables.rows.every(({ relforcerowsecurity }) => relforcerowsecurity)).toBe(true);
  });

  it('persiste mensagem e outbox atomicamente e reproduz idempotência pelo hash', async () => {
    const input = {
      id: randomUUID(), organizationId: organizationA, channelId: channelA,
      conversationId: conversationA, source: 'AUTOMATION' as const,
      content: { type: 'TEXT' as const, text: 'fixture message' },
      idempotencyKey: 'fixture-idempotency', bodyHash: 'sha256:fixture-body',
      policy: { requireOptIn: true },
    };
    const first = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, input)
    ));
    const replay = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, { ...input, id: randomUUID() })
    ));

    expect(first.kind).toBe('created');
    expect(replay).toMatchObject({ kind: 'replayed', message: { id: first.message.id } });
    const stored = await oneRow<{ messages: number; outbox: number }>(database.pool,
      `SELECT
         (SELECT count(*)::int FROM messaging_messages WHERE id = $1) AS messages,
         (SELECT count(*)::int FROM messaging_outbox WHERE message_id = $1) AS outbox`,
      [first.message.id]);
    expect(stored).toEqual({ messages: 1, outbox: 1 });

    await expect(withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, { ...input, id: randomUUID(), bodyHash: 'sha256:different' })
    ))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    await database.pool.query(
      `UPDATE messaging_outbox SET available_at = '2040-01-01' WHERE message_id = $1`,
      [first.message.id],
    );
  });

  it('deduplica webhook e mantém uma única mensagem recebida', async () => {
    const input = {
      id: randomUUID(), organizationId: organizationA, channelId: channelA,
      conversationId: conversationA, webhookEventKey: 'webhook-event-fixture',
      upstreamMessageId: 'wamid.fixture.incoming',
      content: { type: 'TEXT' as const, text: 'incoming fixture' },
      occurredAt: new Date('2030-01-01T00:00:00.000Z'),
    };
    const first = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.recordIncoming(transaction, input)
    ));
    const duplicate = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.recordIncoming(transaction, { ...input, id: randomUUID() })
    ));
    expect(first.kind).toBe('created');
    expect(first.botScheduled).toBe(true);
    expect(duplicate).toMatchObject({ kind: 'duplicate', message: { id: first.message.id } });
    const botJobs = await oneRow<{ count: number }>(database.pool,
      'SELECT count(*)::int AS count FROM messaging_bot_jobs WHERE organization_id = $1 AND message_id = $2',
      [organizationA, first.message.id]);
    expect(botJobs.count).toBe(1);
  });

  it('não apaga consentimento ou nome conhecido durante ingestão de contato', async () => {
    const repeated = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.upsertContact(transaction, {
        id: randomUUID(), organizationId: organizationA, externalId: 'contact-fixture-a',
        displayName: null, consentStatus: 'UNKNOWN', consentUpdatedAt: null,
      })
    ));
    expect(repeated).toMatchObject({
      id: contactA, displayName: 'Fixture A', consentStatus: 'OPTED_IN', suppressedAt: null,
    });
  });

  it('claims uma vez, revalida imediatamente antes de enviar e expira SENDING para UNKNOWN', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const activeConversation = await createActiveConversation('lease-expiry', now);
    const message = await enqueue('lease-expiry', activeConversation);
    await isolateOutbox(message.id);
    const claim = () => withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    const [one, two] = await Promise.all([claim(), claim()]);
    const claims = [...one, ...two].filter(({ message: row }) => row.id === message.id);
    expect(claims).toHaveLength(1);
    const claimed = claims[0]!;
    const validation = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.validateClaim(transaction, {
        organizationId: organizationA, messageId: message.id, leaseToken: claimed.leaseToken,
        now,
      })
    ));
    expect(validation).toMatchObject({ eligible: true, claim: { message: { state: 'SENDING' } } });

    await withOrganizationTransaction(appPool, organizationA, (transaction) => repository.claimOutgoing(transaction, {
      organizationId: organizationA, workerId: randomUUID(),
      now: new Date(now.getTime() + 30_001), leaseMs: 30_000, limit: 10,
    }));
    const expired = await oneRow<{ state: string }>(database.pool,
      'SELECT state FROM messaging_messages WHERE organization_id = $1 AND id = $2',
      [organizationA, message.id]);
    expect(expired.state).toBe('UNKNOWN');
  });

  it('recupera lease expirado antes da validação sem marcar envio incerto', async () => {
    const now = new Date('2030-01-01T00:10:00.000Z');
    const activeConversation = await createActiveConversation('lease-before-validation', now);
    const message = await enqueue('lease-before-validation', activeConversation);
    await isolateOutbox(message.id);
    const first = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 1_000, limit: 1,
      })
    ));
    expect(first).toHaveLength(1);
    const reclaimed = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(),
        now: new Date(now.getTime() + 1_001), leaseMs: 1_000, limit: 1,
      })
    ));
    expect(reclaimed).toMatchObject([{ message: { id: message.id, state: 'ACCEPTED' } }]);
  });

  it('revalida OPTED_OUT depois do claim sem bloquear texto UNKNOWN dentro da janela', async () => {
    const now = new Date('2030-01-01T00:15:00.000Z');
    const activeConversation = await createActiveConversation('late-opt-out', now);
    const conversation = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.findConversation(transaction, organizationA, activeConversation)
    ));
    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.setContactMessagingPolicy(transaction, {
        organizationId: organizationA, contactId: conversation!.contactId,
        consentStatus: 'UNKNOWN', consentUpdatedAt: now, suppressedAt: null,
      })
    ));
    const message = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: activeConversation, source: 'AUTOMATION',
        content: { type: 'TEXT', text: 'allowed while consent is unknown' },
        idempotencyKey: 'late-opt-out', bodyHash: 'sha256:late-opt-out',
        policy: { requireOptIn: false },
      })
    ));
    await isolateOutbox(message.message.id);
    const [claim] = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    expect(claim?.message.id).toBe(message.message.id);

    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.setContactMessagingPolicy(transaction, {
        organizationId: organizationA, contactId: conversation!.contactId,
        consentStatus: 'OPTED_OUT', consentUpdatedAt: now, suppressedAt: null,
      })
    ));
    const validation = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.validateClaim(transaction, {
        organizationId: organizationA, messageId: message.message.id,
        leaseToken: claim!.leaseToken, now,
      })
    ));
    expect(validation).toEqual({ eligible: false, reason: 'CONTACT_CONSENT_REQUIRED' });
    const cancelled = await oneRow<{ state: string; canonicalErrorCode: string | null; outboxCount: number }>(
      database.pool,
      `SELECT message.state, message.canonical_error_code AS "canonicalErrorCode",
              count(outbox.message_id)::int AS "outboxCount"
         FROM messaging_messages message
         LEFT JOIN messaging_outbox outbox
           ON outbox.organization_id = message.organization_id AND outbox.message_id = message.id
        WHERE message.organization_id = $1 AND message.id = $2
        GROUP BY message.state, message.canonical_error_code`,
      [organizationA, message.message.id],
    );
    expect(cancelled).toEqual({
      state: 'FAILED', canonicalErrorCode: 'CONTACT_CONSENT_REQUIRED', outboxCount: 0,
    });
  });

  it('não deixa mensagem posterior ultrapassar uma anterior não resolvida', async () => {
    const now = new Date('2030-01-01T00:20:00.000Z');
    const activeConversation = await createActiveConversation('ordered', now);
    const first = await enqueue('ordered-first', activeConversation);
    const second = await enqueue('ordered-second', activeConversation);
    await isolateOutbox(first.id, second.id);
    const claims = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(),
        now, leaseMs: 30_000, limit: 10,
      })
    ));
    expect(claims).toMatchObject([{ message: { id: first.id } }]);
  });

  it('reconcilia status Meta que chegou antes do vínculo do ID upstream', async () => {
    const now = new Date('2030-01-01T00:30:00.000Z');
    const activeConversation = await createActiveConversation('early-status', now);
    const message = await enqueue('early-status', activeConversation);
    await isolateOutbox(message.id);
    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.recordStatusEvent(transaction, {
        organizationId: organizationA, channelId: channelA,
        upstreamMessageId: 'wamid.early-status', state: 'READ', occurredAt: now,
      })
    ));
    const [claim] = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    const validated = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.validateClaim(transaction, {
        organizationId: organizationA, messageId: message.id, leaseToken: claim!.leaseToken, now,
      })
    ));
    expect(validated.eligible).toBe(true);
    const completed = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.completeSend(transaction, {
        organizationId: organizationA, messageId: message.id, leaseToken: claim!.leaseToken,
        outcome: { state: 'SENT', upstreamMessageId: 'wamid.early-status' },
      })
    ));
    expect(completed.state).toBe('READ');
  });

  it('serializa status Meta concorrente com o vínculo do ID upstream', async () => {
    const now = new Date('2030-01-01T00:31:00.000Z');
    const activeConversation = await createActiveConversation('concurrent-status', now);
    const message = await enqueue('concurrent-status', activeConversation);
    await isolateOutbox(message.id);
    const [claim] = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.validateClaim(transaction, {
        organizationId: organizationA, messageId: message.id, leaseToken: claim!.leaseToken, now,
      })
    ));

    const statusWritten = deferred();
    const releaseStatusCommit = deferred();
    const statusTransaction = withOrganizationTransaction(appPool, organizationA, async (transaction) => {
      const result = await repository.recordStatusEvent(transaction, {
        organizationId: organizationA, channelId: channelA,
        upstreamMessageId: 'wamid.concurrent-status', state: 'READ', occurredAt: now,
      });
      statusWritten.resolve();
      await releaseStatusCommit.promise;
      return result;
    });
    await statusWritten.promise;

    const completePid = deferred<number>();
    let completeFinished = false;
    const completionTransaction = withOrganizationTransaction(appPool, organizationA, async (transaction) => {
      const pid = await oneRow<{ pid: number }>(transaction, 'SELECT pg_backend_pid() AS pid');
      completePid.resolve(pid.pid);
      const result = await repository.completeSend(transaction, {
        organizationId: organizationA, messageId: message.id, leaseToken: claim!.leaseToken,
        outcome: { state: 'SENT', upstreamMessageId: 'wamid.concurrent-status' },
      });
      completeFinished = true;
      return result;
    });

    let lockObservation: 'advisory' | 'completed';
    try {
      lockObservation = await waitForAdvisoryLockOrCompletion(
        await completePid.promise,
        () => completeFinished,
      );
    } finally {
      releaseStatusCommit.resolve();
    }
    const [, completed] = await Promise.all([statusTransaction, completionTransaction]);
    expect(lockObservation).toBe('advisory');
    expect(completed.state).toBe('READ');
  });

  it('finaliza falha segura de preflight enquanto o claim ainda está ACCEPTED', async () => {
    const now = new Date('2030-01-01T00:32:00.000Z');
    const rejectedConversation = await createActiveConversation('preflight-rejected', now);
    const rejected = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: rejectedConversation, source: 'OPERATOR',
        content: { type: 'TEMPLATE', name: 'removed_template', language: 'pt_BR', variables: [] },
        idempotencyKey: 'preflight-rejected', bodyHash: 'sha256:preflight-rejected',
        policy: { requireOptIn: true },
      })
    ));
    await isolateOutbox(rejected.message.id);
    const [rejectedClaim] = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    const failed = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.completeSend(transaction, {
        organizationId: organizationA, messageId: rejected.message.id,
        leaseToken: rejectedClaim!.leaseToken,
        outcome: { state: 'FAILED', canonicalErrorCode: 'META_TEMPLATE_NOT_APPROVED', retrySafe: false },
      })
    ));
    expect(failed).toMatchObject({ state: 'FAILED', canonicalErrorCode: 'META_TEMPLATE_NOT_APPROVED' });
    const rejectedOutbox = await oneRow<{ count: number }>(database.pool,
      'SELECT count(*)::int AS count FROM messaging_outbox WHERE organization_id = $1 AND message_id = $2',
      [organizationA, rejected.message.id]);
    expect(rejectedOutbox.count).toBe(0);
    await expect(withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.retrySafeFailure(transaction, {
        organizationId: organizationA, messageId: rejected.message.id, notBefore: now,
      })
    ))).rejects.toMatchObject({ code: 'INVALID_MESSAGE_TRANSITION' });

    const retryConversation = await createActiveConversation('preflight-retry', now);
    const retryable = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: retryConversation, source: 'OPERATOR',
        content: { type: 'TEMPLATE', name: 'lookup_retry', language: 'pt_BR', variables: [] },
        idempotencyKey: 'preflight-retry', bodyHash: 'sha256:preflight-retry',
        policy: { requireOptIn: true },
      })
    ));
    await isolateOutbox(retryable.message.id);
    const [retryClaim] = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.completeSend(transaction, {
        organizationId: organizationA, messageId: retryable.message.id,
        leaseToken: retryClaim!.leaseToken,
        outcome: { state: 'FAILED', canonicalErrorCode: 'META_TEMPLATE_LOOKUP_FAILED', retrySafe: true },
      })
    ));
    const retried = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.retrySafeFailure(transaction, {
        organizationId: organizationA, messageId: retryable.message.id, notBefore: now,
      })
    ));
    expect(retried).toMatchObject({ state: 'ACCEPTED', canonicalErrorCode: null });
  });

  it('preserva a ordem dos textos Typebot ao recarregar a conversa', async () => {
    const incoming = await oneRow<{ id: string }>(database.pool,
      `SELECT id FROM messaging_messages
        WHERE organization_id = $1 AND upstream_message_id = 'wamid.fixture.incoming'`,
      [organizationA]);
    await database.pool.query(
      `UPDATE messaging_bot_jobs SET status = 'PAUSED'
        WHERE organization_id = $1 AND message_id <> $2 AND status = 'PENDING'`,
      [organizationA, incoming.id],
    );
    const now = new Date('2030-01-01T00:01:00.000Z');
    const claim = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimBotTurn(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000,
      })
    ));
    expect(claim?.message.id).toBe(incoming.id);
    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.completeBotTurn(transaction, {
        organizationId: organizationA, messageId: incoming.id, leaseToken: claim!.leaseToken,
        sessionId: 'typebot-session-fixture', texts: ['typebot first', 'typebot second'], now,
      })
    ));
    const messages = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.listConversationMessages(transaction, organizationA, conversationA, 100)
    ));
    expect(messages.flatMap(({ content }) => content.type === 'TEXT' && content.text.startsWith('typebot ')
      ? [content.text] : [])).toEqual(['typebot first', 'typebot second']);
  });

  it('troca o bot sem deixar sessão ou job do vínculo anterior executável', async () => {
    const now = new Date('2030-01-01T00:02:00.000Z');
    const incoming = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.recordIncoming(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: conversationA, webhookEventKey: 'bot-rebind-event',
        upstreamMessageId: 'wamid.bot-rebind', content: { type: 'TEXT', text: 'rebind' }, occurredAt: now,
      })
    ));
    const claim = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimBotTurn(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000,
      })
    ));
    expect(claim?.message.id).toBe(incoming.message.id);
    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.setChannelBot(transaction, {
        organizationId: organizationA, channelId: channelA,
        botPublicId: 'replacement-bot', botOriginReference: 'typebot-origin-replacement',
      })
    ));
    const state = await oneRow<{
      botPublicId: string; botOriginReference: string; typebotSessionId: string | null; jobStatus: string;
    }>(database.pool,
      `SELECT conversation.bot_public_id AS "botPublicId",
              conversation.bot_origin_reference AS "botOriginReference",
              conversation.typebot_session_id AS "typebotSessionId", job.status AS "jobStatus"
         FROM messaging_conversations conversation
         JOIN messaging_bot_jobs job
           ON job.organization_id = conversation.organization_id AND job.conversation_id = conversation.id
        WHERE conversation.organization_id = $1 AND job.message_id = $2`,
      [organizationA, incoming.message.id]);
    expect(state).toEqual({
      botPublicId: 'replacement-bot', botOriginReference: 'typebot-origin-replacement',
      typebotSessionId: null, jobStatus: 'UNKNOWN',
    });
  });

  it('bloqueia automação em atendimento humano mas permite operador', async () => {
    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.setConversationMode(transaction, {
        organizationId: organizationA, conversationId: conversationA, mode: 'HUMAN',
      })
    ));
    await expect(enqueue('paused-auto')).rejects.toMatchObject({ code: 'CONVERSATION_PAUSED' });
    const manual = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: conversationA, source: 'OPERATOR',
        content: { type: 'TEXT', text: 'manual fixture' },
        idempotencyKey: 'manual-while-human', bodyHash: 'sha256:manual',
        policy: { requireOptIn: true },
      })
    ));
    expect(manual.kind).toBe('created');
  });

  it('cancela replies automáticas pendentes ao assumir HUMAN sem bloquear template do operador', async () => {
    const now = new Date('2030-01-01T00:03:00.000Z');
    const selectedConversationId = await createActiveConversation('human-takeover', now);
    const incoming = await oneRow<{ id: string }>(database.pool,
      `SELECT id FROM messaging_messages
        WHERE organization_id = $1 AND upstream_message_id = 'wamid.window-human-takeover'`,
      [organizationA]);
    await database.pool.query(
      `UPDATE messaging_bot_jobs SET status = 'PAUSED'
        WHERE organization_id = $1 AND message_id <> $2 AND status = 'PENDING'`,
      [organizationA, incoming.id],
    );
    const botClaim = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimBotTurn(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000,
      })
    ));
    expect(botClaim?.message.id).toBe(incoming.id);
    const completion = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.completeBotTurn(transaction, {
        organizationId: organizationA, messageId: incoming.id, leaseToken: botClaim!.leaseToken,
        sessionId: 'human-takeover-session', texts: ['queued first', 'queued second'], now,
      })
    ));
    expect(completion.kind).toBe('completed');
    if (completion.kind !== 'completed') throw new Error('BOT_COMPLETION_EXPECTED');
    await isolateOutbox(...completion.messages.map(({ id }) => id));
    const [leasedAccepted] = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    expect(leasedAccepted?.message.id).toBe(completion.messages[0]!.id);

    await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.setConversationMode(transaction, {
        organizationId: organizationA, conversationId: selectedConversationId, mode: 'HUMAN',
      })
    ));
    const cancelled = await database.pool.query<{
      id: string; state: string; canonicalErrorCode: string | null; outboxCount: number;
    }>(
      `SELECT message.id, message.state,
              message.canonical_error_code AS "canonicalErrorCode",
              count(outbox.message_id)::int AS "outboxCount"
         FROM messaging_messages message
         LEFT JOIN messaging_outbox outbox
           ON outbox.organization_id = message.organization_id AND outbox.message_id = message.id
        WHERE message.organization_id = $1 AND message.id = ANY($2::uuid[])
        GROUP BY message.id, message.state, message.canonical_error_code, message.sequence_number
        ORDER BY message.sequence_number`,
      [organizationA, completion.messages.map(({ id }) => id)],
    );
    expect(cancelled.rows).toEqual(completion.messages.map(({ id }) => ({
      id, state: 'FAILED', canonicalErrorCode: 'CONVERSATION_PAUSED', outboxCount: 0,
    })));
    await expect(withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.retrySafeFailure(transaction, {
        organizationId: organizationA, messageId: completion.messages[0]!.id, notBefore: now,
      })
    ))).rejects.toMatchObject({ code: 'INVALID_MESSAGE_TRANSITION' });

    const operator = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: selectedConversationId, source: 'OPERATOR',
        content: { type: 'TEMPLATE', name: 'operator_followup', language: 'pt_BR', variables: [] },
        idempotencyKey: 'operator-after-human', bodyHash: 'sha256:operator-after-human',
        policy: { requireOptIn: true },
      })
    ));
    await isolateOutbox(operator.message.id);
    const claims = await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.claimOutgoing(transaction, {
        organizationId: organizationA, workerId: randomUUID(), now, leaseMs: 30_000, limit: 1,
      })
    ));
    expect(claims).toMatchObject([{ message: { id: operator.message.id, source: 'OPERATOR' } }]);
  });

  async function enqueue(key: string, selectedConversationId = conversationA) {
    return (await withOrganizationTransaction(appPool, organizationA, (transaction) => (
      repository.enqueueOutgoing(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: selectedConversationId, source: 'AUTOMATION',
        content: { type: 'TEXT', text: key }, idempotencyKey: key,
        bodyHash: `sha256:${key}`, policy: { requireOptIn: true },
      })
    ))).message;
  }

  async function createActiveConversation(key: string, occurredAt: Date): Promise<string> {
    return withOrganizationTransaction(appPool, organizationA, async (transaction) => {
      const contact = await repository.upsertContact(transaction, {
        id: randomUUID(), organizationId: organizationA, externalId: `claim-${key}`,
        displayName: null, consentStatus: 'OPTED_IN', consentUpdatedAt: occurredAt,
      });
      const conversation = await repository.getOrCreateConversation(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA, contactId: contact.id,
      });
      await repository.recordIncoming(transaction, {
        id: randomUUID(), organizationId: organizationA, channelId: channelA,
        conversationId: conversation.id, webhookEventKey: `window-${key}`,
        upstreamMessageId: `wamid.window-${key}`,
        content: { type: 'TEXT', text: 'window fixture' }, occurredAt,
      });
      return conversation.id;
    });
  }

  async function isolateOutbox(...messageIds: string[]): Promise<void> {
    await database.pool.query(
      `UPDATE messaging_outbox
          SET available_at = CASE WHEN message_id = ANY($1::uuid[]) THEN now() ELSE '2040-01-01' END`,
      [messageIds],
    );
  }

  async function waitForAdvisoryLockOrCompletion(
    pid: number,
    isComplete: () => boolean,
  ): Promise<'advisory' | 'completed'> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (isComplete()) return 'completed';
      const activity = await database.pool.query<{ waitEvent: string | null }>(
        `SELECT wait_event AS "waitEvent" FROM pg_stat_activity WHERE pid = $1`,
        [pid],
      );
      if (activity.rows[0]?.waitEvent === 'advisory') return 'advisory';
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for completeSend lock state');
  }
});
