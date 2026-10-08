import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { attendanceDatabase, seedAttendanceTenant } from './helpers/attendance.js';
import { createAutomationSafeHttp } from '../../src/modules/automation-integrations/safe-http.js';
import { createCredentialService, createCredentialVault } from '../../src/modules/automation-integrations/credentials.js';
import { createAutomationHttpEffectDispatcher } from '../../src/modules/automations/http-effect.js';
import { createAutomationService, createEventRouter, createExecutionService, createOutboxDispatcher } from '../../src/modules/automations/service.js';
import { createPostgresAutomationRepository, type OutboxRow } from '../../src/modules/automations/repository.js';

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, data });
const edge = (source: string, target: string, port = 'next') => ({ id: `${source}-${port}`, source, target, port });
const graph = { nodes: [node('start', 'start'), node('http', 'http', { method: 'POST', url: 'https://synthetic.example/action',
  credentialId: '22222222-2222-4222-8222-222222222222', target: 'lookup', timeoutMs: 10, retryAttempts: 2 }), node('end', 'end')],
  edges: [edge('start', 'http'), ...['success', 'client_error', 'server_error', 'timeout', 'unknown'].map(port => edge('http', 'end', port))] };

// Uses the source isolated PG/app-role fixtures. HTTP is a synthetic connector;
// no network service, provider credentials, active database or schema is used.
describe('HTTP uncertainty persists the real IO wait and outbox barrier', () => {
  let lab: Awaited<ReturnType<typeof attendanceDatabase>>;
  const repository = createPostgresAutomationRepository();
  const vault = createCredentialVault(JSON.stringify({ '1': Buffer.alloc(32, 17).toString('base64') }));
  const credentials = () => createCredentialService({ transact: lab.transact, vault });
  beforeAll(async () => { lab = await attendanceDatabase(); }, 120000);
  afterAll(async () => { await lab?.dispose(); });
  async function setup() {
    const tenant = await seedAttendanceTenant(lab.database, false);
    await lab.database.pool.query('insert into flow_features(organization_id,enabled) values($1,true)', [tenant.org]);
    const credential = await credentials().create(tenant.org, { name: 'synthetic HTTP', type: 'BEARER', secret: { token: 'synthetic-canary' }, metadata: {} });
    const published = { ...graph, nodes: graph.nodes.map(item => item.id === 'http' ? { ...item, data: { ...item.data, credentialId: credential.id } } : item) };
    const service = createAutomationService({ transact: lab.transact, enabled: true });
    const draft = await service.create(tenant.org, { name: 'HTTP uncertainty fixture', graph: published });
    await service.publish(tenant.org, draft.id, draft.draft.revision);
    await service.bind(tenant.org, draft.id, { channelId: tenant.channel });
    await lab.database.pool.query("update messaging_conversations set mode='BOT' where organization_id=$1 and id=$2", [tenant.org, tenant.conversation]);
    const first = await createEventRouter({ transact: lab.transact, enabled: true }).route(tenant.org, {
      channelId: tenant.channel, conversationId: tenant.conversation, eventKey: randomUUID(), text: 'synthetic start' });
    const execution = createExecutionService({ transact: lab.transact, enabled: true });
    expect(await execution.runOnce(tenant.org)).toMatchObject({ status: 'WAITING' });
    const id = first.execution!.id;
    const outbox = await lab.transact(tenant.org, tx => repository.listExecutionOutbox(tx, tenant.org, id));
    expect(outbox).toHaveLength(1); expect(outbox[0]).toMatchObject({ kind: 'IO_HTTP', status: 'PENDING' });
    const actor = (await lab.database.pool.query('select user_id from memberships where organization_id=$1', [tenant.org])).rows[0].user_id as string;
    return { ...tenant, id, actor, execution, httpId: outbox[0]!.id };
  }
  function worker(request: ReturnType<typeof createAutomationSafeHttp>) {
    const audit = async (item: OutboxRow, outcome: string, started: number, credentialId?: string, detail: Record<string, unknown> = {}) =>
      lab.transact(item.organizationId, async tx => { await tx.query(`insert into automation_io_audit(organization_id,execution_id,node_id,kind,credential_id,outcome,duration_ms,detail)
        values($1,$2,$3,$4,$5,$6,$7,$8)`, [item.organizationId, item.executionId, item.nodeId, item.kind, credentialId ?? null, outcome, Date.now() - started, JSON.stringify(detail)]); });
    const external = createAutomationHttpEffectDispatcher({ request, audit, resolveCredential: credentials().resolve });
    return createOutboxDispatcher({ transact: lab.transact, enabled: true }, external, ['IO_HTTP']);
  }
  async function wait(org: string, id: string) {
    return (await lab.database.pool.query('select kind,status from automation_waits where organization_id=$1 and execution_id=$2', [org, id])).rows;
  }
  it('survives restart and expired lease without resuming IO, overtaking, retrying or exposing a secret', async () => {
    const t = await setup(), tail = randomUUID();
    await lab.database.pool.query(`insert into automation_outbox(organization_id,id,execution_id,node_id,ordinal,kind,payload)
      values($1,$2,$3,'tail',2000,'SEND_TEXT','{"text":"synthetic tail"}')`, [t.org, tail, t.id]);
    const connect = vi.fn(() => new Promise<Response>(() => {}));
    const request = createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect });
    expect(await worker(request).runOnce(t.org)).toMatchObject({ status: 'UNKNOWN' });
    const uncertain = (await lab.database.pool.query('select status,last_error,lease_token,lease_expires_at from automation_outbox where organization_id=$1 and id=$2', [t.org, t.httpId])).rows[0];
    expect(uncertain).toMatchObject({ status: 'UNKNOWN', last_error: 'AUTOMATION_HTTP_TIMEOUT' });
    expect(uncertain.lease_token).toBeTruthy(); expect(uncertain.lease_expires_at).toBeTruthy();
    expect(await lab.transact(t.org, tx => repository.recordUnknownOutbox(tx, t.org, t.httpId, randomUUID(), 'AUTOMATION_HTTP_AUDIT_FAILED'))).toBe(false);
    expect(await lab.transact(randomUUID(), tx => repository.recordUnknownOutbox(tx, randomUUID(), t.httpId, uncertain.lease_token, 'AUTOMATION_HTTP_AUDIT_FAILED'))).toBe(false);
    await lab.database.pool.query("update automation_outbox set lease_expires_at=now()-interval '1 minute' where organization_id=$1 and id=$2", [t.org, t.httpId]);
    expect(await worker(request).runOnce(t.org)).toEqual({ processed: false });
    expect(await createExecutionService({ transact: lab.transact, enabled: true }).runOnce(t.org)).toEqual({ processed: false });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await wait(t.org, t.id)).toEqual([{ kind: 'IO', status: 'WAITING' }]);
    const rows = await lab.transact(t.org, tx => repository.listExecutionOutbox(tx, t.org, t.id));
    expect(rows[0]?.lastError).toBe('AUTOMATION_HTTP_TIMEOUT');
    expect(rows.map(row => [row.id, row.status, row.attempts])).toEqual([[t.httpId, 'UNKNOWN', 1], [tail, 'PENDING', 0]]);
    expect(await lab.transact(t.org, tx => repository.claimOutbox(tx, t.org, randomUUID(), 120000, ['SEND_TEXT']))).toBeNull();
    const other = randomUUID();
    expect(await lab.transact(other, tx => repository.listExecutionOutbox(tx, other, t.id))).toEqual([]);
    const execution = await t.execution.get(t.org, t.id);
    expect(execution).toMatchObject({ status: 'WAITING', state: { variables: {} } });
    expect((await lab.database.pool.query("select * from automation_events where organization_id=$1 and type='EXPLICIT_RESUME'", [t.org])).rows).toEqual([]);
    const audit = (await lab.database.pool.query('select outcome,detail from automation_io_audit where organization_id=$1', [t.org])).rows;
    expect(audit).toEqual([{ outcome: 'unknown', detail: { error: 'AUTOMATION_HTTP_TIMEOUT' } }]);
    expect(JSON.stringify(audit)).not.toContain('synthetic-canary');
    await t.execution.reconcile(t.org, t.id, t.actor, { outboxId: t.httpId, outcome: 'UNRESOLVED', evidenceCode: 'SYNTHETIC_PENDING' });
    expect(await worker(request).runOnce(t.org)).toEqual({ processed: false });
    await t.execution.reconcile(t.org, t.id, t.actor, { outboxId: t.httpId, outcome: 'CONFIRMED_SENT', evidenceCode: 'SYNTHETIC_CONFIRMED', providerReference: 'synthetic-receipt' });
    expect(await lab.transact(t.org, tx => repository.recordUnknownOutbox(tx, t.org, t.httpId, uncertain.lease_token, 'AUTOMATION_HTTP_AUDIT_FAILED'))).toBe(false);
    // Existing recovery contract: a receipt alone does not invent the HTTP output
    // or resume the IO wait. A separate explicit contract is still needed.
    expect(await wait(t.org, t.id)).toEqual([{ kind: 'IO', status: 'WAITING' }]);
    expect(await t.execution.runOnce(t.org)).toEqual({ processed: false });
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('permits replay only after explicit CONFIRMED_NOT_SENT and resumes with the actual completed response', async () => {
    const t = await setup(), connect = vi.fn(() => new Promise<Response>(() => {}));
    expect(await worker(createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect })).runOnce(t.org)).toMatchObject({ status: 'UNKNOWN' });
    await t.execution.reconcile(t.org, t.id, t.actor, { outboxId: t.httpId, outcome: 'CONFIRMED_NOT_SENT', evidenceCode: 'SYNTHETIC_NOT_SENT' });
    const replay = vi.fn(async () => new Response('actual synthetic output'));
    expect(await worker(createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect: replay })).runOnce(t.org)).toMatchObject({ status: 'SENT' });
    expect(replay).toHaveBeenCalledTimes(1);
    expect(await wait(t.org, t.id)).toEqual([{ kind: 'IO', status: 'RESUMED' }]);
    expect(await t.execution.runOnce(t.org)).toMatchObject({ status: 'COMPLETED' });
    expect(await t.execution.get(t.org, t.id)).toMatchObject({ state: { variables: { lookup: { status: 200, body: 'actual synthetic output' } } } });
  });
  it('resumes the timeout port after POST DNS timeout proved before dispatch', async () => {
    const t = await setup(), connect = vi.fn();
    expect(await worker(createAutomationSafeHttp({ resolve: () => new Promise(() => {}), connect })).runOnce(t.org)).toMatchObject({ status: 'FAILED' });
    expect(connect).not.toHaveBeenCalled();
    expect(await wait(t.org, t.id)).toEqual([{ kind: 'IO', status: 'RESUMED' }]);
    expect(await t.execution.runOnce(t.org)).toMatchObject({ status: 'COMPLETED' });
    expect(await t.execution.get(t.org, t.id)).toMatchObject({ state: { variables: { lookup: { error: 'AUTOMATION_HTTP_TIMEOUT' } } } });
  });
});
