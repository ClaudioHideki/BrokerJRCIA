import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createAutomationService, createEventRouter, createExecutionService } from '../../src/modules/automations/service.js';
import { createPostgresAutomationRepository } from '../../src/modules/automations/repository.js';

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, data });
const edge = (source: string, target: string, port = 'next') => ({ id: source + port, source, target, port });
const questionGraph = { nodes: [node('start', 'start'), node('name', 'input', { variable: 'name', text: 'Nome?' }),
  node('department', 'input', { variable: 'department', text: 'Setor?' }), node('answer', 'message', { text: '{{name}}/{{department}}' }), node('end', 'end')],
  edges: [edge('start', 'name'), edge('name', 'department'), edge('department', 'answer'), edge('answer', 'end')] };

describe('serial conversation input persistence', () => {
  let lab: Awaited<ReturnType<typeof attendanceDatabase>>;
  beforeAll(async () => {
    lab = await attendanceDatabase();
  }, 60000);
  afterAll(async () => { await lab?.dispose(); });
  async function setup(graph = questionGraph) {
    const tenant = await seedAttendanceTenant(lab.database, false);
    await lab.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [tenant.org]);
    const service = createAutomationService({ transact: lab.transact, enabled: true });
    const draft = await service.create(tenant.org, { name: 'Serial fixture', graph });
    await service.publish(tenant.org, draft.id, draft.draft.revision);
    await service.bind(tenant.org, draft.id, { channelId: tenant.channel });
    await lab.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2", [tenant.org, tenant.conversation]);
    const router = createEventRouter({ transact: lab.transact, enabled: true });
    const route = (text: string, eventKey = randomUUID()) => router.route(tenant.org, {
      channelId: tenant.channel, conversationId: tenant.conversation, eventKey, text });
    const worker = () => createExecutionService({ transact: lab.transact, enabled: true });
    return { ...tenant, service, draft, route, worker };
  }
  it('keeps one execution and consumes two rapid replies once after worker restarts', async () => {
    const t = await setup();
    const first = await t.route('Olá');
    await t.route('Maria', 'second'); await t.route('Financeiro', 'third');
    const count = await lab.database.pool.query('select count(*)::int as total from automation_executions where organization_id=$1', [t.org]);
    expect(count.rows[0].total).toBe(1);
    for (let turn = 0; turn < 3; turn++) expect((await t.worker().runOnce(t.org)).processed).toBe(true);
    expect(await t.worker().runOnce(t.org)).toEqual({ processed: false });
    const detail = await t.worker().get(t.org, first.execution!.id);
    expect(detail).toMatchObject({ status: 'COMPLETED', state: { variables: { name: 'Maria', department: 'Financeiro' } } });
    const events = await lab.database.pool.query('select status from automation_events where organization_id=$1', [t.org]);
    expect(events.rows).toHaveLength(3);
    expect(events.rows.every(e => e.status === 'CONSUMED')).toBe(true);
  });
  it('deduplicates an input delivered concurrently without creating a second execution', async () => {
    const t = await setup(), key = randomUUID();
    const results = await Promise.all([t.route('Olá', key), t.route('Olá', key)]);
    expect(results.filter(r => r.duplicate)).toHaveLength(1);
    expect((await lab.database.pool.query('select count(*)::int as n from automation_executions where organization_id=$1', [t.org])).rows[0].n).toBe(1);
  });
  it('admits distinct replies into the existing execution while a worker holds a lease', async () => {
    const t = await setup(), first = await t.route('Olá');
    const repository = createPostgresAutomationRepository();
    const claimed = await lab.transact(t.org, tx => repository.claimExecution(tx, t.org, randomUUID(), 60000));
    expect(claimed?.status).toBe('RUNNING');
    await Promise.all([t.route('Maria', 'running-a'), t.route('Financeiro', 'running-b')]);
    const executions = await lab.database.pool.query('select id,status from automation_executions where organization_id=$1', [t.org]);
    expect(executions.rows).toEqual([{ id: first.execution!.id, status: 'RUNNING' }]);
    const events = await lab.database.pool.query("select event_key,status,execution_id from automation_events where organization_id=$1 and event_key in ('running-a','running-b') order by queue_sequence", [t.org]);
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every(e => e.status === 'PENDING' && e.execution_id === first.execution!.id)).toBe(true);
  });
  it('allows replies to an existing paused binding but refuses new conversation admission', async () => {
    const t = await setup(), first = await t.route('Olá');
    await t.worker().runOnce(t.org);
    const binding = (await t.service.bindings(t.org, t.draft.id)).data[0]!;
    await t.service.setBindingStatus(t.org, binding.id, { status: 'PAUSED', revision: binding.revision }, t.draft.id);
    expect(await t.route('Maria')).toMatchObject({ execution: { id: first.execution!.id }, resumed: true });
    await t.worker().runOnce(t.org);
    await t.route('Suporte'); await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org, first.execution!.id)).toMatchObject({ status: 'COMPLETED', state: { variables: { name: 'Maria', department: 'Suporte' } } });
    expect(await t.route('Novo atendimento')).toMatchObject({ execution: null });
    expect((await lab.database.pool.query('select count(*)::int as n from automation_executions where organization_id=$1', [t.org])).rows[0].n).toBe(1);
  });
  it('queues a message received during IO without consuming or replacing the IO wait', async () => {
    const graph = { nodes: [node('start', 'start'), node('http', 'http', { method: 'GET', url: 'https://example.test/lookup',
      credentialId: '22222222-2222-4222-8222-222222222222', target: 'lookup' }), node('answer', 'input', { variable: 'answer', text: 'Confirmar?' }), node('end', 'end')],
      edges: [edge('start', 'http'), ...['success', 'client_error', 'server_error', 'timeout', 'unknown'].map(port => edge('http', 'answer', port)), edge('answer', 'end')] };
    const t = await setup(graph), first = await t.route('Olá');
    expect(await t.worker().runOnce(t.org)).toMatchObject({ status: 'WAITING' });
    await t.route('Sim', 'during-io');
    expect(await t.worker().runOnce(t.org)).toEqual({ processed: false });
    const wait = await lab.database.pool.query("select kind,status from automation_waits where organization_id=$1 and status='WAITING'", [t.org]);
    expect(wait.rows).toEqual([{ kind: 'IO', status: 'WAITING' }]);
    const output = { accounts: [{ active: true }], long: 'x'.repeat(9000) };
    await t.worker().resume(t.org, first.execution!.id, 'io-result', { outcome: 'success', output });
    await t.worker().runOnce(t.org);
    await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org, first.execution!.id)).toMatchObject({
      status: 'COMPLETED', state: { variables: { lookup: { accounts: output.accounts }, answer: 'Sim' } } });
    // Inspection redacts/truncates display text; the persisted runtime value must remain intact.
    const stored = (await lab.database.pool.query('select state from automation_executions where organization_id=$1 and id=$2', [t.org, first.execution!.id])).rows[0].state;
    expect(stored.variables.lookup.long.length).toBe(9000);
    expect(stored.variables.lookup).toEqual(output);
  });
  it('keeps a delay scheduled when a reply arrives and consumes that reply only after the timer', async () => {
    const graph = { nodes: [node('start', 'start'), node('delay', 'delay', { seconds: 60 }),
      node('answer', 'input', { variable: 'answer', text: 'Nome?' }), node('end', 'end')],
      edges: [edge('start', 'delay'), edge('delay', 'answer'), edge('answer', 'end')] };
    const t = await setup(graph), first = await t.route('Olá');
    await t.worker().runOnce(t.org);
    await t.route('Maria');
    expect(await t.worker().runOnce(t.org)).toEqual({ processed: false });
    expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
    await lab.database.pool.query("update automation_waits set wake_at=now()-interval '1 second' where organization_id=$1 and kind='DELAY'", [t.org]);
    expect(await t.worker().releaseDueWaits(t.org)).toBe(1);
    await t.worker().runOnce(t.org); await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org, first.execution!.id)).toMatchObject({ status: 'COMPLETED', state: { variables: { answer: 'Maria' } } });
  });
  it('continues the published version originally selected while a newer version is published', async () => {
    const t = await setup(), first = await t.route('Olá');
    await t.worker().runOnce(t.org);
    const changed = { ...questionGraph, nodes: questionGraph.nodes.map(n => n.id === 'answer' ? node('answer', 'message', { text: 'NEW' }) : n) };
    const saved = await t.service.save(t.org, t.draft.id, { name: t.draft.name, revision: t.draft.draft.revision, graph: changed });
    await t.service.publish(t.org, t.draft.id, saved.draft.revision);
    await t.route('Maria'); await t.worker().runOnce(t.org);
    await t.route('Suporte'); await t.worker().runOnce(t.org);
    const detail = await t.worker().get(t.org, first.execution!.id);
    expect(detail).toMatchObject({ version: 1, state: { variables: { name: 'Maria', department: 'Suporte' } } });
    const effects = await lab.database.pool.query("select payload from automation_outbox where organization_id=$1 and node_id='answer'", [t.org]);
    expect(effects.rows).toEqual([{ payload: { text: 'Maria/Suporte' } }]);
  });
});
