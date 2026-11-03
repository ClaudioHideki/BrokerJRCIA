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
  async function expireSyntheticDelay(org:string){
    // Move both persisted deadlines together: changing only the wait row would
    // model corrupt state rather than an elapsed clock after worker replacement.
    await lab.database.pool.query(`update automation_executions set state=jsonb_set(state,'{waiting,wakeAt}',
      to_jsonb(floor(extract(epoch from now()-interval '1 second')*1000)::bigint))
      where organization_id=$1 and status='WAITING'`,[org]);
    await lab.database.pool.query(`update automation_waits w set wake_at=to_timestamp((e.state->'waiting'->>'wakeAt')::double precision/1000),state=e.state
      from automation_executions e where w.organization_id=$1 and e.organization_id=w.organization_id and e.id=w.execution_id and w.kind='DELAY' and w.status='WAITING'`,[org]);
  }
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
  it('pages execution metadata with full-period totals, tenant isolation and historical simulation after publication',async()=>{
    const graph={nodes:[node('start','start'),node('end','end')],edges:[edge('start','end')]};
    const t=await setup(graph),other=await setup(graph),ids:string[]=[];
    for(let i=0;i<3;i++){const started=await t.route('Mensagem '+i);ids.push(started.execution!.id);await t.worker().runOnce(t.org);}
    await other.route('Outra empresa');await other.worker().runOnce(other.org);
    const query={from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString(),pageSize:2,status:'COMPLETED' as const};
    const first=await t.worker().list(t.org,undefined,query);if(!('metrics' in first))throw Error('INSPECTION_RESULT_REQUIRED');
    expect(first.metrics).toMatchObject({total:3,completed:3,completionRate:100});expect(first.data).toHaveLength(2);
    const second=await t.worker().list(t.org,undefined,{...query,cursor:first.nextCursor!});if(!('metrics' in second))throw Error('INSPECTION_RESULT_REQUIRED');
    expect(second.data).toHaveLength(1);expect(second.metrics.total).toBe(3);
    expect(new Set([...first.data,...second.data].map(row=>row.id))).toEqual(new Set(ids));
    await expect(Promise.resolve().then(()=>t.worker().list(other.org,undefined,{...query,cursor:first.nextCursor!}))).rejects.toMatchObject({code:'AUTOMATION_CURSOR_INVALID'});
    const saved=await t.service.get(t.org,t.draft.id),updated={nodes:[node('start','start'),node('new','message',{text:'Nova versão'}),node('end','end')],edges:[edge('start','new'),edge('new','end')]};
    const draft=await t.service.save(t.org,t.draft.id,{name:'Versão nova',graph:updated,revision:saved.draft.revision});await t.service.publish(t.org,t.draft.id,draft.draft.revision);
    expect(await t.worker().playground(t.org,ids[0]!)).toMatchObject({text:'Mensagem 0',version:1});
    const replay=await t.worker().simulateHistorical(t.org,ids[0]!,{text:'Replay'});
    expect(replay).toMatchObject({status:'COMPLETED',effects:[],source:{version:1}});
    expect((await lab.database.pool.query('select count(*)::int as n from automation_executions where organization_id=$1',[t.org])).rows[0].n).toBe(3);
  });
  it('deduplicates an input delivered concurrently without creating a second execution', async () => {
    const t = await setup(), key = randomUUID();
    const results = await Promise.all([t.route('Olá', key), t.route('Olá', key)]);
    expect(results.filter(r => r.duplicate)).toHaveLength(1);
    expect((await lab.database.pool.query('select count(*)::int as n from automation_executions where organization_id=$1', [t.org])).rows[0].n).toBe(1);
  });
  it('uses the published keyword policy only for initial admission and enforces once-per-conversation after completion',async()=>{
    const graph=structuredClone(questionGraph);
    graph.nodes[0]!.data={entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ONCE_PER_CONVERSATION',
      keywords:{mode:'EXACT',terms:['orçamento'],quantifier:'ANY',ignoreCase:true,ignoreAccents:true}};
    const t=await setup(graph);
    expect(await t.route('Suporte')).toMatchObject({execution:null});
    const first=await t.route('ORCAMENTO');expect(first.execution).not.toBeNull();
    await t.worker().runOnce(t.org);
    // Replies continue the pinned execution, even when they do not match entry keywords.
    await t.route('Nome sintético');await t.worker().runOnce(t.org);
    await t.route('Setor sintético');await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org,first.execution!.id)).toMatchObject({status:'COMPLETED'});
    const attempts=await Promise.all([t.route('orçamento'),t.route('ORÇAMENTO')]);
    expect(attempts.every(attempt=>attempt.execution===null)).toBe(true);
    expect((await lab.database.pool.query('select count(*)::int as n from automation_executions where organization_id=$1',[t.org])).rows[0].n).toBe(1);
    const saved=await t.service.get(t.org,t.draft.id),draft=structuredClone(questionGraph);
    // Draft changes cannot change the already bound immutable admission policy.
    await t.service.save(t.org,t.draft.id,{name:'Rascunho sem filtro',graph:draft,revision:saved.draft.revision});
    expect(await t.route('Outro início')).toMatchObject({execution:null});
  });
  it('persists typed input attempts through worker replacement and keeps the normalized number typed',async()=>{
    const graph={nodes:[node('start','start'),node('capture','input',{inputConfigVersion:2,inputType:'number',maxAttempts:2,variable:'answer',timeoutSeconds:60}),node('end','end')],
      edges:[edge('start','capture'),edge('capture','end'),edge('capture','end','exhausted'),edge('capture','end','timeout')]};
    const t=await setup(graph),first=await t.route('Oi');await t.worker().runOnce(t.org);
    await t.route('inválido','typed-invalid');await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org,first.execution!.id)).toMatchObject({status:'WAITING',state:{waiting:{invalidAttempts:1}}});
    expect(await t.route('inválido','typed-invalid')).toMatchObject({duplicate:true});
    await t.route('12,5','typed-valid');await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org,first.execution!.id)).toMatchObject({status:'COMPLETED',state:{variables:{answer:12.5}}});
  });
  it('persists the bounded menu counter across workers and does not count a duplicate event twice',async()=>{
    const graph={nodes:[node('start','start'),node('menu','menu',{text:'Escolha',menuConfigVersion:1,maxAttempts:3,
      options:[{value:'1',label:'Comercial'},{value:'2',label:'Suporte'}]}),node('fallback','message',{text:'Limite atingido'}),node('end','end')],
      edges:[edge('start','menu'),edge('menu','end','option-1'),edge('menu','end','option-2'),edge('menu','fallback','exhausted'),edge('fallback','end')]};
    const t=await setup(graph),first=await t.route('Olá');await t.worker().runOnce(t.org);
    const snapshot=async()=> (await lab.database.pool.query('select state from automation_executions where organization_id=$1 and id=$2',[t.org,first.execution!.id])).rows[0].state;
    expect((await snapshot()).waiting.invalidAttempts).toBe(0);
    await t.route('9','invalid-once');expect(await t.route('9','invalid-once')).toMatchObject({duplicate:true});
    await t.worker().runOnce(t.org);expect((await snapshot()).waiting.invalidAttempts).toBe(1);
    expect(await t.worker().runOnce(t.org)).toEqual({processed:false});
    const savedWait=(await lab.database.pool.query("select state from automation_waits where organization_id=$1 and execution_id=$2 and status='WAITING'",[t.org,first.execution!.id])).rows[0].state;
    expect(savedWait.waiting.invalidAttempts).toBe(1);
    await t.route('x','invalid-twice');await t.worker().runOnce(t.org);expect((await snapshot()).waiting.invalidAttempts).toBe(2);
    await t.route('0','invalid-thrice');await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org,first.execution!.id)).toMatchObject({status:'COMPLETED'});
    expect((await snapshot()).waiting).toBeUndefined();
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
    const persisted=(await lab.database.pool.query('select state from automation_executions where organization_id=$1 and id=$2',[t.org,first.execution!.id])).rows[0].state;
    const deadline=(await lab.database.pool.query("select wake_at from automation_waits where organization_id=$1 and kind='DELAY' and status='WAITING'",[t.org])).rows[0].wake_at;
    expect(persisted.waiting.wakeAt).toBe(deadline.getTime());
    await t.route('Maria');
    expect(await t.worker().runOnce(t.org)).toEqual({ processed: false });
    expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
    await expireSyntheticDelay(t.org);
    expect(await t.worker().releaseDueWaits(t.org)).toBe(1);
    expect(await t.worker().releaseDueWaits(t.org)).toBe(0);
    await t.worker().runOnce(t.org); await t.worker().runOnce(t.org);
    expect(await t.worker().get(t.org, first.execution!.id)).toMatchObject({ status: 'COMPLETED', state: { variables: { answer: 'Maria' } } });
  });
  it('does not execute an expired timer after human takeover and worker replacement',async()=>{
    const graph={nodes:[node('start','start'),node('delay','delay',{seconds:60}),node('answer','message',{text:'Automatic reply'}),node('end','end')],edges:[edge('start','delay'),edge('delay','answer'),edge('answer','end')]};
    const t=await setup(graph),first=await t.route('Olá');
    expect(await t.worker().runOnce(t.org)).toMatchObject({status:'WAITING'});
    await expireSyntheticDelay(t.org);
    await lab.database.pool.query("update messaging_conversations set mode='HUMAN' where organization_id=$1 and id=$2",[t.org,t.conversation]);
    expect(await t.worker().releaseDueWaits(t.org)).toBe(1);
    expect(await t.worker().runOnce(t.org)).toEqual({processed:false});
    expect((await lab.database.pool.query('select count(*)::int as n from automation_outbox where organization_id=$1 and execution_id=$2',[t.org,first.execution!.id])).rows[0].n).toBe(0);
    expect(await t.worker().get(t.org,first.execution!.id)).toMatchObject({status:'QUEUED'});
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
