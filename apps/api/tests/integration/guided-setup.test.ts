import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createAutomationService } from '../../src/modules/automations/service.js';
import { createAutomationPackageService } from '../../src/modules/automation-integrations/package-service.js';
import { createGuidedSetupService } from '../../src/modules/guided-setup/service.js';
import { createSetupStore } from '../../src/modules/guided-setup/repository.js';
import { assertSetupOperation } from '../../src/modules/guided-setup/native-owner.js';
import { createNativeSetupProofReader } from '../../src/modules/guided-setup/native-proof.js';
import { writeSetupAudit } from '../../src/modules/guided-setup/audit.js';

describe('guided setup real PostgreSQL isolation and durable receipts', () => {
  let db: Awaited<ReturnType<typeof attendanceDatabase>>;
  let a: Awaited<ReturnType<typeof seedAttendanceTenant>>, b: typeof a;
  let actor: string, packages: ReturnType<typeof createAutomationPackageService>, service: ReturnType<typeof createGuidedSetupService>;
  const artifact = () => ({ format: 'jrc-broker-package/1', rootKey: 'root', flows: [{ key: 'root', name: 'Portable support', graph: welcomeFlow() }] });
  beforeAll(async () => {
    db = await attendanceDatabase(); a = await seedAttendanceTenant(db.database); b = await seedAttendanceTenant(db.database);
    await db.database.pool.query('INSERT INTO flow_features(organization_id,enabled) VALUES($1,true),($2,true)', [a.org, b.org]);
    actor = (await db.database.pool.query('SELECT user_id FROM memberships WHERE organization_id=$1', [a.org])).rows[0].user_id;
    const automations = createAutomationService({ transact: db.transact });
    packages = createAutomationPackageService({ transact: db.transact, automations });
    service = createGuidedSetupService({ transact: db.transact, isEnabled: () => true,
      resolveCurrentRole: async () => 'OWNER', ports: { validateSelection: async () => {} } });
  }, 60000);
  afterAll(async () => { await db?.dispose(); });
  it('atomically imports one package under concurrent idempotent requests and isolates numeric collisions', async () => {
    const [first, replay] = await Promise.all([packages.import(a.org, artifact(), 'same-package'), packages.import(a.org, artifact(), 'same-package')]);
    expect(replay.id).toBe(first.id); expect(replay.rootId).toBe(first.rootId);
    const second = await packages.import(b.org, artifact(), 'same-package'); expect(second.rootId).not.toBe(first.rootId);
    await expect(packages.get(b.org, first.id)).rejects.toMatchObject({ code: 'AUTOMATION_PACKAGE_NOT_FOUND' });
    await expect(packages.import(a.org, { ...artifact(), rootKey: 'missing' }, 'invalid-package')).rejects.toThrow();
    expect((await db.transact(a.org, tx => tx.query('SELECT count(*)::int AS n FROM automation_packages'))).rows[0].n).toBe(1);
    expect((await db.transact(a.org, tx => tx.query('SELECT * FROM automation_bindings'))).rows).toEqual([]);
  });
  it('publishes via native immutable versions and exports references without changing the channel owner', async () => {
    const imported = await packages.import(a.org, artifact(), 'publish-package');
    const published = await packages.publish(a.org, imported.id, imported.revision, 'publish-package-once');
    expect(published.state).toBe('PUBLISHED');
    const replay = await packages.publish(a.org, imported.id, imported.revision, 'publish-package-once'); expect(replay.publications).toEqual(published.publications);
    const portable = await packages.export(a.org, published.rootId, published.publications.root!.version);
    expect(portable.format).toBe('jrc-broker-package/1'); expect(portable.flows).toHaveLength(1);
    expect((await db.transact(a.org, tx => tx.query('SELECT * FROM attendance_owners'))).rows).toEqual([]);
  });
  it('persists setup revisions, rejects foreign reads and safely cancels without deleting resources', async () => {
    const principal = { organizationId: a.org, actorId: actor };
    const first = await service.start(principal, { name: 'Guided support', transport: 'QR' }, 'same-setup');
    expect((await service.start(principal, { name: 'Guided support', transport: 'QR' }, 'same-setup')).id).toBe(first.id);
    await expect(service.get({ ...principal, organizationId: b.org }, first.id)).rejects.toMatchObject({ code: 'GUIDED_SETUP_NOT_FOUND' });
    const updated = await service.update(principal, first.id, { revision: first.revision, selection: { transport: 'META' } }, 'update-setup');
    await expect(service.update(principal, first.id, { revision: first.revision, selection: { transport: 'QR' } }, 'stale-setup')).rejects.toMatchObject({ code: 'GUIDED_SETUP_CHANGED' });
    const cancelled = await service.cancel(principal, first.id, { revision: updated.revision }, 'cancel-setup'); expect(cancelled.state).toBe('CANCELLED');
    expect((await db.transact(a.org, tx => tx.query('SELECT * FROM messaging_channels WHERE id=$1', [a.channel]))).rowCount).toBe(1);
  });
  it('enforces RLS, document scope constraints and append-preserving privileges for both manifests', async () => {
    for (const table of ['automation_packages', 'guided_setup_operations']) {
      const id = randomUUID();
      await db.transact(a.org, tx => tx.query(`INSERT INTO ${table}(organization_id,id,data) VALUES($1,$2,$3)`, [a.org, id, JSON.stringify({ id, organizationId: a.org })]));
      expect((await db.transact(b.org, tx => tx.query(`SELECT * FROM ${table} WHERE id=$1`, [id]))).rows).toEqual([]);
      await expect(db.transact(b.org, tx => tx.query(`INSERT INTO ${table}(organization_id,id,data) VALUES($1,$2,$3)`, [a.org, randomUUID(), '{}']))).rejects.toMatchObject({ code: '42501' });
      await expect(db.transact(a.org, tx => tx.query(`INSERT INTO ${table}(organization_id,id,data) VALUES($1,$2,'{}')`, [a.org, randomUUID()]))).rejects.toMatchObject({ code: '23514' });
      await expect(db.transact(a.org, tx => tx.query(`DELETE FROM ${table} WHERE id=$1`, [id]))).rejects.toMatchObject({ code: '42501' });
    }
  });
  it('checks saved operation leases under real row locks and records the actual administrator', async () => {
    const principal = { organizationId: a.org, actorId: actor }, store = createSetupStore();
    const setup = await service.start(principal, { name: 'Lease test', transport: 'QR' }, 'lease-test');
    await db.transact(a.org, async tx => {
      const row = (await store.get(tx, a.org, setup.id, true))!;
      row.operation = { key: 'intent', actorId: actor, kind: 'TEST', requestHash: 'x', input: {}, leaseToken: 'current', leaseExpiresAt: Date.now() + 60000 };
      await store.put(tx, row); await assertSetupOperation(tx, a.org, setup.id, 'current');
      await writeSetupAudit(tx, principal, setup.id, 'TESTED', { channelId: a.channel });
    });
    await expect(db.transact(a.org, tx => assertSetupOperation(tx, a.org, setup.id, 'abandoned'))).rejects.toMatchObject({ code: 'GUIDED_SETUP_LEASE_LOST' });
    // Runtime audit access intentionally permits INSERT only; inspect the receipt
    // through the isolated test administrator without widening application grants.
    await expect(db.transact(a.org, tx => tx.query('SELECT id FROM audit_logs'))).rejects.toMatchObject({ code: '42501' });
    const audit = await db.database.pool.query('SELECT actor_id,metadata FROM audit_logs WHERE organization_id=$1 AND resource_id=$2', [a.org, setup.id]);
    expect(audit.rows).toEqual([{ actor_id: actor, metadata: { channelId: a.channel } }]);
  });
  it('runs every proof predicate against real tables and rejects invented or foreign executions', async () => {
    const reader = createNativeSetupProofReader({ transact: db.transact,
      channels: { get: async () => ({ organizationId: a.org, messagingChannelId: a.channel }) } as never });
    const record: any = { organizationId: a.org, selection: { channelId: a.channel, integrationId: a.integration },
      testContext: { automationId: a.automation, version: 1, startedAt: new Date(0).toISOString(), keyword: 'test-receipt', ownerRevision: 1 } };
    await expect(reader({ organizationId: a.org, actorId: actor }, record, randomUUID())).rejects.toMatchObject({ code: 'GUIDED_SETUP_TEST_INPUT_NOT_RECEIVED' });
    await expect(reader({ organizationId: b.org, actorId: actor }, record)).rejects.toMatchObject({ code: 'GUIDED_SETUP_SCOPE_MISMATCH' });
    const binding = (await db.database.pool.query('INSERT INTO automation_bindings(organization_id,automation_id,version,channel_id) VALUES($1,$2,1,$3) RETURNING id', [a.org, a.automation, a.channel])).rows[0].id;
    const execution = (await db.database.pool.query(`INSERT INTO automation_executions(organization_id,automation_id,version,binding_id,channel_id,conversation_id,trigger_event_key,correlation_id,input,status)
      VALUES($1,$2,1,$3,$4,$5,'proof-entry',$6,'{"text":"humano"}','HANDOFF') RETURNING id`, [a.org, a.automation, binding, a.channel, a.conversation, randomUUID()])).rows[0].id;
    await db.database.pool.query("INSERT INTO automation_events(organization_id,execution_id,event_key,type,payload,status) VALUES($1,$2,'proof-entry','MESSAGE','{\"text\":\"test-receipt\"}','CONSUMED')", [a.org, execution]);
    const result = await reader({ organizationId: a.org, actorId: actor }, record, execution);
    expect(result.executionId).toBe(execution); expect(result.evidence).toEqual({ scopeMatches: false, entryReceived: false, selectionsReceived: false,
      botDelivered: false, mirrorConfirmed: false, handoffConfirmed: false, humanPaused: false, unresolvedEffects: false });
    const incoming = randomUUID(), outgoing = randomUUID(), handoff = randomUUID();
    await db.database.pool.query(`INSERT INTO messaging_messages(id,organization_id,channel_id,conversation_id,direction,source,upstream_message_id,content,state)
      VALUES($1,$3,$4,$5,'INCOMING','CONTACT','synthetic-entry','{"type":"TEXT","text":"test-receipt"}','DELIVERED'),
      ($2,$3,$4,$5,'OUTGOING','AUTOMATION','synthetic-reply','{"type":"TEXT","text":"Menu sintético"}','DELIVERED')`, [incoming, outgoing, a.org, a.channel, a.conversation]);
    await db.database.pool.query(`INSERT INTO automation_events(organization_id,execution_id,event_key,type,payload,status)
      VALUES($1,$2,'proof-option','MESSAGE','{"text":"1"}','CONSUMED'),($1,$2,'proof-human','MESSAGE','{"text":"humano"}','CONSUMED')`, [a.org, execution]);
    await db.database.pool.query(`INSERT INTO automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,status,remote_reference)
      VALUES($1,$2,$3,'handoff',2,'HANDOFF','SENT',NULL),($1,$4,$3,'menu',1,'SEND_TEXT','SENT',$5)`, [a.org, handoff, execution, randomUUID(), outgoing]);
    await db.database.pool.query(`INSERT INTO chatwoot_messages(organization_id,integration_id,message_id,remote_message_id) VALUES($1,$2,$3,701),($1,$2,$4,702)`, [a.org, a.integration, incoming, outgoing]);
    await db.database.pool.query(`INSERT INTO attendance_sessions(organization_id,channel_id,conversation_id,integration_id,destination_revision,account_id,inbox_id,cycle,state,owner_revision,execution_id,automation_id,version)
      VALUES($1,$2,$3,$4,1,7,9,1,'HUMAN_ACTIVE',1,$5,$6,1)`, [a.org, a.channel, a.conversation, a.integration, execution, a.automation]);
    await db.database.pool.query("UPDATE messaging_conversations SET mode='HUMAN' WHERE organization_id=$1 AND id=$2", [a.org, a.conversation]);
    await db.database.pool.query(`INSERT INTO attendance_handoff_operations(organization_id,outbox_id,execution_id,channel_id,conversation_id,integration_id,lease_token,snapshot,phase,state,confirmed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CONFIRMED','APPLIED','DISPATCH_READBACK')`, [a.org, handoff, execution, a.channel, a.conversation, a.integration, randomUUID(), JSON.stringify({ scope: a.scope })]);
    const proved = await reader({ organizationId: a.org, actorId: actor }, record, execution);
    expect(proved.evidence).toEqual({ scopeMatches: true, entryReceived: true, selectionsReceived: true, botDelivered: true,
      mirrorConfirmed: true, handoffConfirmed: true, humanPaused: true, unresolvedEffects: false });
    await db.database.pool.query("UPDATE messaging_messages SET state='SENT' WHERE id=$1", [outgoing]);
    expect((await reader({ organizationId: a.org, actorId: actor }, record, execution)).evidence.botDelivered).toBe(false);
  });
});
