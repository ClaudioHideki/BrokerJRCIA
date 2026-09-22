import { randomUUID } from 'node:crypto';

import { welcomeFlow } from '@jrc/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrate.js';
import { withOrganizationTransaction } from '../../src/db/tenant-transaction.js';
import { createLegacyFlowMigrationService } from '../../src/modules/automations/legacy-migration.js';
import { createFlowService } from '../../src/modules/flows/service.js';
import { createPostgresMessagingRepository } from '../../src/modules/messaging/repository.js';
import {
  createIsolatedPostgresDatabase,
  requireTestDatabaseAdminUrl,
  type IsolatedPostgresDatabase,
} from './helpers/postgres.js';
import { withGlobalRoleLock } from './helpers/global-role-lock.js';
import { connectionStringForRole } from './helpers/task7.js';

describe('legacy flow owner transition', () => {
  let database: IsolatedPostgresDatabase;
  let runtimePool: Pool;
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const transact = <T>(org: string, work: Parameters<typeof withOrganizationTransaction<T>>[2]) =>
    withOrganizationTransaction(runtimePool, org, work);
  const flows = createFlowService({ transact });
  const migration = createLegacyFlowMigrationService({ transact });
  const messaging = createPostgresMessagingRepository();

  beforeAll(async () => {
    const adminUrl = requireTestDatabaseAdminUrl();
    database = await createIsolatedPostgresDatabase(adminUrl);
    await withGlobalRoleLock(adminUrl, () => runMigrations(database.connectionString));
    const seed = await database.pool.connect();
    try {
      await seed.query('begin');
      await seed.query(
        `insert into organizations(id, name, slug) values ($1, 'Owner transition', $2)`,
        [organizationId, `owner-${organizationId}`],
      );
      await seed.query(
        `insert into users(id, email, password_hash)
         values ($1, $2, 'test-only-no-login')`,
        [actorId, `owner-${organizationId}@example.test`],
      );
      await seed.query(
        `insert into memberships(organization_id, user_id, role)
         values ($1, $2, 'OWNER')`,
        [organizationId, actorId],
      );
      await seed.query(
        `insert into flow_features(organization_id, enabled) values ($1, true)`,
        [organizationId],
      );
      await seed.query('commit');
    } catch (error) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
    }
    runtimePool = new Pool({
      connectionString: connectionStringForRole(database.connectionString, 'jrc_app'),
    });
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await database?.dispose();
  });

  it('waits for live work, cuts over once, rejects unsafe rollback and audits safe rollback', async () => {
    const flow = await flows.create(organizationId, { name: 'Cutover', graph: welcomeFlow() });
    await flows.publish(organizationId, flow.id, flow.revision);
    const context = await transact(organizationId, async (tx) => {
      const provider = await tx.query<{ id: string }>(
        `insert into provider_accounts(organization_id, provider, name, credential_reference)
         values ($1, 'META', 'synthetic', 'vault://synthetic') returning id`,
        [organizationId],
      );
      const channel = await messaging.createChannel(tx, {
        id: randomUUID(),
        organizationId,
        providerAccountId: provider.rows[0]!.id,
        phoneNumberId: 'owner-transition-phone',
        wabaId: 'owner-transition-waba',
        credentialReference: 'vault://synthetic',
        botPublicId: null,
        botOriginReference: null,
      });
      const contact = await messaging.upsertContact(tx, {
        id: randomUUID(),
        organizationId,
        externalId: 'owner-transition-contact',
        displayName: 'Cliente',
        consentStatus: 'OPTED_IN',
        consentUpdatedAt: new Date(),
      });
      const conversation = await messaging.getOrCreateConversation(tx, {
        id: randomUUID(),
        organizationId,
        channelId: channel.id,
        contactId: contact.id,
      });
      return { channelId: channel.id, conversationId: conversation.id };
    });
    await flows.bind(organizationId, flow.id, context.channelId);
    await transact(organizationId, (tx) => tx.query(
      `insert into flow_sessions
         (organization_id, conversation_id, flow_id, version, feature_revision, state)
       values ($1, $2, $3, 1, 1, '{"status":"waiting"}'::jsonb)`,
      [organizationId, context.conversationId, flow.id],
    ));

    const waiting = await migration.migrateBatch(organizationId, { actorId });
    expect(waiting.items).toContainEqual(expect.objectContaining({
      flowId: flow.id,
      status: 'WAITING_FOR_DRAIN',
      live: 1,
    }));
    expect((await database.pool.query(
      `select bot_origin_reference from messaging_channels
        where organization_id=$1 and id=$2`,
      [organizationId, context.channelId],
    )).rows[0].bot_origin_reference).toBe('jrc-flows-native');

    await transact(organizationId, (tx) => tx.query(
      `delete from flow_sessions where organization_id=$1 and conversation_id=$2`,
      [organizationId, context.conversationId],
    ));
    const [first, second] = await Promise.all([
      migration.cutover(organizationId, flow.id, actorId),
      migration.cutover(organizationId, flow.id, actorId),
    ]);
    expect([first.status, second.status]).toEqual(['MANAGED', 'MANAGED']);
    const binding = await database.pool.query<{ id: string; status: string }>(
      `select id, status from automation_bindings
        where organization_id=$1 and automation_id=$2 and channel_id=$3`,
      [organizationId, flow.id, context.channelId],
    );
    expect(binding.rows).toEqual([expect.objectContaining({ status: 'ACTIVE' })]);
    expect((await database.pool.query(
      `select count(*)::int as count from automation_owner_transitions
        where organization_id=$1 and channel_id=$2 and reason_code='LEGACY_FLOW_CUTOVER'`,
      [organizationId, context.channelId],
    )).rows[0].count).toBe(1);

    const executionId = randomUUID();
    await transact(organizationId, (tx) => tx.query(
      `insert into automation_executions
         (organization_id, id, automation_id, version, binding_id, channel_id,
          trigger_event_key, correlation_id, status)
       values ($1, $2, $3, 1, $4, $5, $6, $7, 'RUNNING')`,
      [organizationId, executionId, flow.id, binding.rows[0]!.id, context.channelId,
        `transition-${executionId}`, randomUUID()],
    ));
    await expect(migration.rollback(organizationId, flow.id, actorId)).rejects.toMatchObject({
      message: 'AUTOMATION_ROLLBACK_ACTIVE_EXECUTIONS',
      statusCode: 409,
    });

    await transact(organizationId, (tx) => tx.query(
      `update automation_executions set status='COMPLETED', completed_at=now()
        where organization_id=$1 and id=$2`,
      [organizationId, executionId],
    ));
    await expect(migration.rollback(organizationId, flow.id, actorId)).resolves.toEqual({
      flowId: flow.id,
      status: 'ROLLED_BACK',
      channels: 1,
    });
    expect((await database.pool.query(
      `select bot_origin_reference, bot_public_id from messaging_channels
        where organization_id=$1 and id=$2`,
      [organizationId, context.channelId],
    )).rows[0]).toEqual({
      bot_origin_reference: 'jrc-flows-native',
      bot_public_id: flow.id,
    });
    expect((await database.pool.query(
      `select from_origin, to_origin, actor_id, reason_code
         from automation_owner_transitions
        where organization_id=$1 and channel_id=$2 order by created_at`,
      [organizationId, context.channelId],
    )).rows).toEqual([
      {
        from_origin: 'jrc-flows-native',
        to_origin: 'jrc-automation-v2',
        actor_id: actorId,
        reason_code: 'LEGACY_FLOW_CUTOVER',
      },
      {
        from_origin: 'jrc-automation-v2',
        to_origin: 'jrc-flows-native',
        actor_id: actorId,
        reason_code: 'ROLLBACK_TO_LEGACY_FLOW',
      },
    ]);
  });

  it('does not take over a channel whose owner changed before cutover', async () => {
    const flow = await flows.create(organizationId, { name: 'Owner conflict', graph: welcomeFlow() });
    await flows.publish(organizationId, flow.id, flow.revision);
    await migration.migrateBatch(organizationId, { actorId });
    const channel = await transact(organizationId, async (tx) => {
      const provider = await tx.query<{ id: string }>(
        `select id from provider_accounts where organization_id=$1 limit 1`,
        [organizationId],
      );
      return messaging.createChannel(tx, {
        id: randomUUID(),
        organizationId,
        providerAccountId: provider.rows[0]!.id,
        phoneNumberId: `conflict-${randomUUID()}`,
        wabaId: 'owner-transition-waba',
        credentialReference: 'vault://synthetic',
        botPublicId: null,
        botOriginReference: null,
      });
    });
    await flows.bind(organizationId, flow.id, channel.id);
    const bindingId = randomUUID();
    await transact(organizationId, async (tx) => {
      await tx.query(
        `insert into automation_bindings
           (organization_id, id, automation_id, version, channel_id, status)
         values ($1, $2, $3, 1, $4, 'PAUSED')`,
        [organizationId, bindingId, flow.id, channel.id],
      );
      await tx.query(
        `update messaging_channels
            set bot_origin_reference='another-runtime', bot_public_id='another-bot'
          where organization_id=$1 and id=$2`,
        [organizationId, channel.id],
      );
    });

    await expect(migration.cutover(organizationId, flow.id, actorId)).resolves.toMatchObject({
      status: 'CONFLICT',
    });
    expect((await database.pool.query(
      `select bot_origin_reference, bot_public_id from messaging_channels
        where organization_id=$1 and id=$2`,
      [organizationId, channel.id],
    )).rows[0]).toEqual({
      bot_origin_reference: 'another-runtime',
      bot_public_id: 'another-bot',
    });
    expect((await database.pool.query(
      `select status from automation_bindings where organization_id=$1 and id=$2`,
      [organizationId, bindingId],
    )).rows[0].status).toBe('PAUSED');
  });
});
