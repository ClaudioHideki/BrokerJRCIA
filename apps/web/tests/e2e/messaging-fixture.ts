import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { MetaCloudClient } from '@jrc/providers';
import { withOrganizationTransaction } from '../../../api/src/db/tenant-transaction.js';
import { createPostgresMessagingRepository } from '../../../api/src/modules/messaging/repository.js';
import { createMessagingService } from '../../../api/src/modules/messaging/service.js';
import { createMessagingWorker } from '../../../api/src/modules/messaging/worker.js';
import { createMetaIngestor } from '../../../api/src/modules/messaging/ingest.js';

/** Only imported by Playwright: real database/worker, synthetic external providers. */
export async function createMessagingFixture(adminPool: Pool, appPool: Pool) {
  const repository = createPostgresMessagingRepository();
  const organizations = (await adminPool.query<{ id: string; name: string }>('SELECT id, name FROM organizations ORDER BY name')).rows;
  const bindings: Record<string, { organizationId: string; channelId: string }> = {};
  const transact = <T>(org: string, operation: Parameters<typeof withOrganizationTransaction<T>>[2]) => withOrganizationTransaction(appPool, org, operation);
  for (const [index, org] of organizations.entries()) {
    const phoneNumberId = `1000000000${index}`;
    await transact(org.id, async tx => {
      const account = (await tx.query<{ id: string }>("INSERT INTO provider_accounts (organization_id, provider, name, credential_reference) VALUES ($1, 'META', 'Meta E2E sintética', 'e2e-meta') RETURNING id", [org.id])).rows[0]!;
      const channel = await repository.createChannel(tx, { id: randomUUID(), organizationId: org.id, providerAccountId: account.id, phoneNumberId,
        wabaId: '20000000000', credentialReference: 'e2e-meta', botPublicId: 'e2e-support', botOriginReference: 'e2e-typebot' });
      const contact = await repository.upsertContact(tx, { id: randomUUID(), organizationId: org.id, externalId: '5511999990000', displayName: 'Contato sintético E2E', consentStatus: 'OPTED_IN', consentUpdatedAt: new Date() });
      await repository.getOrCreateConversation(tx, { id: randomUUID(), organizationId: org.id, channelId: channel.id, contactId: contact.id });
      bindings[phoneNumberId] = { organizationId: org.id, channelId: channel.id };
    });
    if (org.name === 'JRC E2E Matriz') process.env.JRC_E2E_META_PHONE_ID = phoneNumberId;
  }
  const ingest = createMetaIngestor({ repository, bindings, transact });
  const resolveMetaClient = async (channel: { phoneNumberId: string }): Promise<Pick<MetaCloudClient, 'listTemplates' | 'sendText' | 'sendTemplate'>> => {
    const accepted = async () => {
      const upstreamMessageId = `wamid.e2e.${randomUUID()}`;
      await ingest({ object: 'whatsapp_business_account', entry: [{ id: '20000000000', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: channel.phoneNumberId }, statuses: [{ id: upstreamMessageId, timestamp: `${Math.floor(Date.now() / 1000)}`, status: 'delivered' }],
      } }] }] });
      return { status: 'ACCEPTED' as const, upstreamMessageId };
    };
    return { async listTemplates() { return [{ id: '30000000000', name: 'e2e_boas_vindas', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá {{1}}' }] }]; },
      sendTemplate: accepted, sendText: accepted };
  };
  const service = createMessagingService({ repository, runInOrganizationTransaction: transact, resolveMetaClient,
    async resolveTypebotClient() { return { async startChat() { throw new Error('configuration must not start chat'); }, async continueChat() { throw new Error('configuration must not continue chat'); } }; } });
  const worker = createMessagingWorker({ repository, transact, resolveMetaClient,
    async resolveTypebotClient() {
      const result = async (_id: string, text?: string) => ({ sessionId: 'e2e-session', texts: [`Resposta sintética Typebot: ${text}`, 'Segunda mensagem sintética'], incompatibilities: [] });
      return { startChat: result, continueChat: result };
    } });
  let running: Promise<void> | undefined;
  let failure = false;
  const timer = setInterval(() => {
    if (running) return;
    running = (async () => { for (const org of organizations) await worker.runOnce(org.id); })()
      .catch(() => { failure = true; }).finally(() => { running = undefined; });
  }, 100);
  return { service, ingest, async close() { clearInterval(timer); await running; delete process.env.JRC_E2E_META_PHONE_ID; if (failure) throw new Error('Messaging fixture worker failed'); } };
}
