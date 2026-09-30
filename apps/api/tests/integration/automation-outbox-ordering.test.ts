import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createAutomationService, createOutboxDispatcher } from '../../src/modules/automations/service.js';
import { createPostgresAutomationRepository, type OutboxKind, type OutboxRow } from '../../src/modules/automations/repository.js';
import type { RuntimeResult } from '../../src/modules/automations/types.js';

// Real isolated PostgreSQL, app role and existing attendance authority. All
// effects are synthetic; no provider, Chatwoot or other remote API is called.
describe('durable automation outbox ordering', () => {
  let h: Awaited<ReturnType<typeof attendanceDatabase>>;
  let tenant: Awaited<ReturnType<typeof seedAttendanceTenant>>;
  let bindingId: string;
  let executionId: string;
  const repository = createPostgresAutomationRepository();
  const kinds: OutboxKind[] = ['SEND_TEXT', 'HANDOFF', 'RESUME_EVENT', 'IO_HTTP', 'IO_SQL', 'IO_CODE', 'IO_AI'];

  beforeAll(async () => { h = await attendanceDatabase(); }, 60000);
  afterAll(async () => { await h?.dispose(); });
  beforeEach(async () => {
    tenant = await seedAttendanceTenant(h.database, false);
    await h.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [tenant.org]);
    const binding = await createAutomationService({ transact: h.transact, enabled: true })
      .bind(tenant.org, tenant.automation, { channelId: tenant.channel, version: 1 });
    bindingId = binding.id;
    await h.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2", [tenant.org, tenant.conversation]);
    executionId = await newExecution(tenant.conversation);
  });

  async function newExecution(conversation: string | null): Promise<string> {
    const id = randomUUID();
    await h.transact(tenant.org, async tx => {
      await tx.query(`insert into automation_executions(organization_id,id,automation_id,version,binding_id,channel_id,conversation_id,
        trigger_event_key,correlation_id,status) values($1,$2,$3,1,$4,$5,$6,$7,$8,'WAITING')`,
      [tenant.org, id, tenant.automation, bindingId, tenant.channel, conversation, `order-${id}`, randomUUID()]);
    });
    return id;
  }
  async function effect(ordinal: number, options: {
    id?: string; execution?: string; kind?: OutboxKind; status?: string; future?: boolean; nodeId?: string;
  } = {}) {
    const id = options.id ?? randomUUID();
    await h.database.pool.query(`insert into automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,payload,status,created_at,available_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,'2020-01-01T00:00:00Z',now()+case when $9 then interval '10 minutes' else interval '-1 minute' end)`,
    [tenant.org, id, options.execution ?? executionId, options.nodeId ?? `node-${id}`, ordinal,
      options.kind ?? 'SEND_TEXT', JSON.stringify({ text: `effect-${ordinal}` }), options.status ?? 'PENDING', options.future ?? false]);
    return id;
  }
  const claim = (accepted = kinds) => h.transact(tenant.org,
    tx => repository.claimOutbox(tx, tenant.org, randomUUID(), 120000, accepted));
  const sent = (item: OutboxRow) => h.transact(tenant.org,
    tx => repository.settleOutbox(tx, tenant.org, item.id, item.leaseToken, { status: 'SENT' }));

  it('persists array order as distinct ordinals across turns, including old producers using zero', async () => {
    const result: RuntimeResult = {
      status: 'WAITING', trace: [], state: { automationId: tenant.automation, version: 1, nodeId: null, variables: {}, steps: 2, stack: [] },
      effects: [
        { nodeId: 'hello', ordinal: 0, kind: 'SEND_TEXT', payload: { text: 'Hello' } },
        { nodeId: 'menu', ordinal: 0, kind: 'SEND_TEXT', payload: { text: 'Menu' } },
      ],
    };
    async function save(turn: number, value: RuntimeResult) {
      const token = randomUUID();
      await h.database.pool.query("update automation_executions set attempts=$3,status='RUNNING',lease_token=$4,lease_expires_at=now()+interval '1 minute' where organization_id=$1 and id=$2", [tenant.org, executionId, turn, token]);
      await h.transact(tenant.org, async tx => {
        const current = await repository.getExecution(tx, tenant.org, executionId);
        if (!current) throw new Error('Fixture execution missing');
        await repository.saveExecutionResult(tx, current, value);
      });
    }
    await save(1, result);
    await save(2, { ...result, effects: [{ nodeId: 'reply', ordinal: 0, kind: 'SEND_TEXT', payload: { text: 'Reply' } }] });
    const rows = await h.transact(tenant.org, tx => repository.listExecutionOutbox(tx, tenant.org, executionId));
    expect(rows.map(row => row.ordinal)).toEqual([1000, 1001, 2000]);
  });

  it('honors ordinals when timestamps tie and UUID sorting opposes the flow', async () => {
    const first = await effect(1000, { id: 'ffffffff-ffff-4fff-8fff-fffffffffff1' });
    const second = await effect(1001, { id: '00000000-0000-4000-8000-000000000001' });
    const a = await claim();
    expect(a?.id).toBe(first);
    expect(await sent(a!)).toBe(true);
    expect((await claim())?.id).toBe(second);
  });

  it('does not overtake a committed reservation while another dispatcher is outside the transaction', async () => {
    await effect(1000); await effect(1001);
    const first = await claim();
    expect(first?.ordinal).toBe(1000);
    expect(await claim()).toBeNull();
    expect(await sent(first!)).toBe(true);
    expect((await claim())?.ordinal).toBe(1001);
  });

  it('allows only one outstanding effect with concurrent app transactions', async () => {
    await effect(1000); await effect(1001); await effect(1002);
    const results = await Promise.all(Array.from({ length: 5 }, () => claim()));
    const claimed = results.filter((row): row is OutboxRow => row !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.ordinal).toBe(1000);
  });

  it('blocks successors during retry backoff instead of filtering the predecessor away', async () => {
    await effect(1000, { future: true }); await effect(1001);
    expect(await claim()).toBeNull();
  });

  it.each(['SENDING', 'UNKNOWN'])('blocks a predecessor in %s even with an expired lease', async status => {
    const id = await effect(1000, { status }); await effect(1001);
    await h.database.pool.query("update automation_outbox set lease_token=$3,lease_expires_at=now()-interval '1 minute' where organization_id=$1 and id=$2", [tenant.org, id, randomUUID()]);
    expect(await claim()).toBeNull();
  });

  it('does not let an IO worker overtake a preceding text claimed by a different worker kind', async () => {
    await effect(1000, { kind: 'SEND_TEXT' }); await effect(1001, { kind: 'IO_CODE' });
    expect(await claim(['IO_CODE'])).toBeNull();
    const first = await claim(['SEND_TEXT']);
    expect(first?.ordinal).toBe(1000);
    expect(await claim(['IO_CODE'])).toBeNull();
    await sent(first!);
    expect((await claim(['IO_CODE']))?.ordinal).toBe(1001);
  });

  it.each(['SENT', 'FAILED', 'CANCELED'])('preserves the existing terminal policy for a predecessor in %s', async status => {
    await effect(1000, { status }); await effect(1001);
    expect((await claim())?.ordinal).toBe(1001);
  });

  it.each(['PENDING', 'SENT'])('does not guess historical tied ordinals even when a peer is %s', async status => {
    await effect(1000, { status }); await effect(1000); await effect(2000);
    expect(await claim()).toBeNull();
    const rows = await h.transact(tenant.org, tx => repository.listExecutionOutbox(tx, tenant.org, executionId));
    expect(rows.filter(row => row.status === 'UNKNOWN')).toHaveLength(0);
    expect(rows).toHaveLength(3);
  });

  it('filters blocked tails before LIMIT so a different execution can make progress', async () => {
    await effect(1000, { future: true });
    for (let i = 1; i <= 51; i++) await effect(1000 + i);
    const other = await newExecution(null);
    const eligible = await effect(1000, { execution: other });
    expect((await claim())?.id).toBe(eligible);
  });

  it('preserves human authority and tenant boundaries', async () => {
    await effect(1000);
    await h.database.pool.query("update messaging_conversations set mode='HUMAN' where organization_id=$1 and id=$2", [tenant.org, tenant.conversation]);
    expect(await claim()).toBeNull();
    const differentTenant = randomUUID();
    expect(await h.transact(differentTenant,
      tx => repository.claimOutbox(tx, differentTenant, randomUUID(), 120000, kinds))).toBeNull();
  });

  it('retains UNKNOWN after external uncertainty without dispatching the next effect', async () => {
    await effect(1000); await effect(1001);
    let calls = 0;
    const dispatcher = createOutboxDispatcher({ transact: h.transact, enabled: true }, {
      dispatch: async () => { calls++; throw new Error('Synthetic lost response'); },
    });
    expect(await dispatcher.runOnce(tenant.org)).toMatchObject({ processed: true, status: 'UNKNOWN' });
    expect(await dispatcher.runOnce(tenant.org)).toEqual({ processed: false });
    expect(calls).toBe(1);
  });
});
