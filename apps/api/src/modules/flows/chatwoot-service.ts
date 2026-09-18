import { executeFlow, type FlowGraph, type FlowState } from '@jrc/contracts';
import type { TenantTransaction } from '../../db/tenant-transaction.js';
import { chatwootEnvironment, type ChatwootOptions } from '../integrations/chatwoot-service.js';
import { readChatwootAccount, type AccountRow } from '../integrations/chatwoot-context.js';
import { ChatwootClient, ChatwootError } from '../integrations/chatwoot-client.js';
import { verifyChatwootSignature } from '../integrations/secrets.js';
import { FlowError } from './service.js';
import { parseFlowChatwootEvent, type FlowChatwootEvent } from './chatwoot-events.js';

interface Binding {
  id: string; organization_id: string; flow_id: string; inbox_id: string; account_id: string;
  destination_revision: number; credential_version: number; feature_revision: number;
  name: string; channel_type: string; bot_id: string | null; encrypted_credentials: string | null;
  status: string; last_error: string | null;
}
interface EventRow { id: string; binding_id: string; conversation_id: string; payload: FlowChatwootEvent; attempts: number }
interface Output { id: string; binding_id: string; conversation_id: string; kind: 'TEXT' | 'HANDOFF'; content: string; attempts: number }
type Options = ChatwootOptions & { resolveBinding(id: string): Promise<string | undefined> };
const view = (b: Binding) => ({ id: b.id, flowId: b.flow_id, inboxId: Number(b.inbox_id), accountId: Number(b.account_id),
  name: b.name, channelType: b.channel_type, status: b.status, lastError: b.last_error });
const errorCode = (e: unknown) => e instanceof FlowError || e instanceof ChatwootError ? e.code : 'FLOW_CHATWOOT_UNAVAILABLE';

export function createFlowChatwootService(options: Options) {
  const env = chatwootEnvironment(options), transact = options.transact;
  const callback = (id: string) => `${options.publicOrigin}/v1/flows/chatwoot/${id}/events`;
  async function feature(tx: TenantTransaction, org: string) {
    const row = (await tx.query<{ revision: number }>(`select f.revision from flow_features f join organizations o on o.id=f.organization_id
      where f.organization_id=$1 and f.enabled and o.status='ACTIVE'`, [org])).rows[0];
    if (!row) throw new FlowError('FLOWS_DISABLED', 403);
    return row;
  }
  async function account(tx: TenantTransaction, org: string) {
    const row = await readChatwootAccount(tx, org);
    if (!row) throw new FlowError('CHATWOOT_ACCOUNT_NOT_CONFIGURED', 409);
    env.client(row); // Approved destination, credential and HTTPS policy are shared with message transport.
    if (row.destination?.mode === 'EXTERNAL' && !options.externalDestinationsEnabled)
      throw new FlowError('CHATWOOT_EXTERNAL_DISABLED', 409);
    return row;
  }
  async function binding(tx: TenantTransaction, org: string, id: string) {
    const b = (await tx.query<Binding>('select * from flow_chatwoot_bindings where organization_id=$1 and id=$2 for update', [org, id])).rows[0];
    if (!b) throw new FlowError('FLOW_BINDING_NOT_FOUND', 404);
    return b;
  }
  async function context(tx: TenantTransaction, b: Binding) {
    const f = await feature(tx, b.organization_id), a = await account(tx, b.organization_id);
    if (Number(a.account_id) !== Number(b.account_id) || a.destination?.revision !== b.destination_revision ||
      a.credential_version !== b.credential_version || f.revision !== b.feature_revision)
      throw new FlowError('FLOW_BINDING_CHANGED', 409);
    return a;
  }
  function credentials(b: Binding): { token: string; secret: string } {
    if (!b.encrypted_credentials) throw new FlowError('FLOW_CHATWOOT_SIGNING_REQUIRED', 409);
    return JSON.parse(env.vault.decrypt(`${b.organization_id}:flow-bot:${b.id}`, b.encrypted_credentials));
  }
  function botClient(a: AccountRow, b: Binding) {
    return new ChatwootClient({ baseUrl: a.base_url, token: credentials(b).token, fetch: options.fetch,
      allowLocal: a.destination?.mode === 'MANAGED' && options.allowLocal === true });
  }
  async function noDirectAutomation(tx: TenantTransaction, org: string, inboxId: number) {
    const conflicts = await tx.query(`select 1 from chatwoot_connections i join messaging_channels c on c.organization_id=i.organization_id and c.id=i.channel_id
      where i.organization_id=$1 and i.inbox_id=$2 and i.status<>'DISABLED' and c.bot_public_id is not null`, [org, inboxId]);
    if (conflicts.rowCount) throw new FlowError('FLOW_CHANNEL_HAS_AUTOMATION', 409);
  }
  async function pause(tx: TenantTransaction, org: string, bindingId: string, conversationId: string | number) {
    await tx.query(`insert into flow_chatwoot_sessions(organization_id,binding_id,conversation_id,human) values($1,$2,$3,true)
      on conflict(organization_id,binding_id,conversation_id) do update set human=true,updated_at=now()`, [org, bindingId, conversationId]);
    await tx.query("update flow_chatwoot_events set status='PAUSED' where organization_id=$1 and binding_id=$2 and conversation_id=$3 and status='PENDING'", [org, bindingId, conversationId]);
    await tx.query("update flow_chatwoot_outbox set status='CANCELED',last_error='FLOW_HUMAN_TAKEOVER' where organization_id=$1 and binding_id=$2 and conversation_id=$3 and status='PENDING'", [org, bindingId, conversationId]);
  }
  async function canonical(a: AccountRow, b: Binding, conversationId: number) {
    const client = env.client(a), assigned = await client.inboxFlowBot(Number(b.account_id), Number(b.inbox_id));
    if (assigned?.id !== Number(b.bot_id) || assigned.outgoing_url !== callback(b.id)) return false;
    const conversation = await client.flowConversation(Number(b.account_id), conversationId);
    if (conversation.account_id !== Number(b.account_id) || conversation.inbox_id !== Number(b.inbox_id))
      throw new FlowError('FLOW_CHATWOOT_BINDING_MISMATCH', 403);
    // Chatwoot pending means the bot owns the turn; open/resolved/snoozed belong to human workflows.
    return conversation.status === 'pending' && (!conversation.meta.assignee ||
      conversation.meta.assignee.type?.toLowerCase().replace('_', '') === 'agentbot' && conversation.meta.assignee.id === Number(b.bot_id));
  }
  const service = {
    async inboxes(org: string) {
      const a = await transact(org, async tx => { await feature(tx, org); return account(tx, org); });
      const inboxes = await env.client(a).listInboxes(Number(a.account_id));
      const bindings = await transact(org, tx => tx.query<Binding>("select * from flow_chatwoot_bindings where organization_id=$1 and status<>'DISABLED' order by created_at", [org]));
      return { accountId: Number(a.account_id), data: inboxes.map(i => ({ id: i.id, name: i.name, channelType: i.channel_type,
        binding: bindings.rows.find(b => Number(b.inbox_id) === i.id) ? view(bindings.rows.find(b => Number(b.inbox_id) === i.id)!) : null })) };
    },
    async bind(org: string, flowId: string, inboxId: number) {
      const saved = await transact(org, async tx => {
        await tx.query("select pg_advisory_xact_lock(hashtextextended('flow-inbox:'||$1,0))", [org]);
        const f = await feature(tx, org), a = await account(tx, org);
        const flow = (await tx.query('select published_version from flows where organization_id=$1 and id=$2', [org, flowId])).rows[0];
        if (!flow?.published_version) throw new FlowError('FLOW_NOT_PUBLISHED', 409);
        await noDirectAutomation(tx, org, inboxId);
        const old = (await tx.query<Binding>("select * from flow_chatwoot_bindings where organization_id=$1 and inbox_id=$2 and status<>'DISABLED'", [org, inboxId])).rows[0];
        if (old) { if (old.flow_id !== flowId) throw new FlowError('FLOW_INBOX_ALREADY_BOUND', 409); await context(tx, old); return old; }
        const inbox = (await env.client(a).listInboxes(Number(a.account_id))).find(i => i.id === inboxId);
        if (!inbox) throw new FlowError('FLOW_INBOX_NOT_FOUND', 404);
        return (await tx.query<Binding>(`insert into flow_chatwoot_bindings(organization_id,flow_id,inbox_id,account_id,destination_revision,credential_version,feature_revision,name,channel_type)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [org, flowId, inboxId, a.account_id, a.destination!.revision, a.credential_version, f.revision, inbox.name, inbox.channel_type])).rows[0]!;
      });
      try {
        return await transact(org, async tx => {
          const b = await binding(tx, org, saved.id), a = await context(tx, b), client = env.client(a);
          await noDirectAutomation(tx, org, inboxId);
          const current = await client.inboxFlowBot(Number(b.account_id), inboxId);
          if (current && (b.bot_id !== null && current.id !== Number(b.bot_id) || current.outgoing_url !== callback(b.id)))
            throw new FlowError('FLOW_INBOX_HAS_BOT', 409);
          const bots = (await client.listFlowBots(Number(b.account_id))).filter(bot => bot.outgoing_url === callback(b.id));
          if (bots.length > 1) throw new FlowError('FLOW_BOT_AMBIGUOUS', 409);
          const bot = bots[0] ?? await client.createFlowBot(Number(b.account_id), `JRC Flow — ${b.name}`, callback(b.id));
          if (!bot.secret || !bot.token) throw new FlowError('FLOW_CHATWOOT_SIGNING_REQUIRED', 409);
          const encrypted = env.vault.encrypt(`${org}:flow-bot:${b.id}`, JSON.stringify({ secret: bot.secret, token: bot.token }));
          // Store and assignment commit together locally. On uncertain remote creation the callback URL reconciles the next attempt.
          await client.setInboxFlowBot(Number(b.account_id), inboxId, bot.id);
          await context(tx, b);
          const updated = (await tx.query<Binding>("update flow_chatwoot_bindings set bot_id=$3,encrypted_credentials=$4,status='READY',last_error=null,updated_at=now() where organization_id=$1 and id=$2 returning *", [org, b.id, bot.id, encrypted])).rows[0]!;
          return view(updated);
        });
      } catch (e) {
        await transact(org, tx => tx.query("update flow_chatwoot_bindings set status=$3,last_error=$4 where organization_id=$1 and id=$2 and status<>'DISABLED'", [org, saved.id, e instanceof ChatwootError && e.uncertain ? 'UNKNOWN' : 'FAILED', errorCode(e)]));
        throw e;
      }
    },
    async disable(org: string, id: string) {
      const b = await transact(org, async tx => {
        const row = await binding(tx, org, id);
        await tx.query("update flow_chatwoot_bindings set status='DISABLED',updated_at=now() where organization_id=$1 and id=$2", [org, id]);
        await tx.query("update flow_chatwoot_events set status='PAUSED' where organization_id=$1 and binding_id=$2 and status='PENDING'", [org, id]);
        await tx.query("update flow_chatwoot_outbox set status='CANCELED' where organization_id=$1 and binding_id=$2 and status='PENDING'", [org, id]);
        return row;
      });
      try {
        const a = await transact(org, tx => account(tx, org));
        if (Number(a.account_id) !== Number(b.account_id) || a.destination?.revision !== b.destination_revision) throw new FlowError('FLOW_BINDING_CHANGED', 409);
        const client = env.client(a), current = await client.inboxFlowBot(Number(b.account_id), Number(b.inbox_id));
        if (current?.id === Number(b.bot_id)) await client.setInboxFlowBot(Number(b.account_id), Number(b.inbox_id), null);
        return { ok: true, remoteDetached: true };
      } catch {
        return { ok: true, remoteDetached: false, code: 'FLOW_REMOVE_REMOTE_BOT_MANUALLY' };
      }
    },
    async ingest(id: string, raw: Buffer, timestamp?: string, signature?: string) {
      const org = await options.resolveBinding(id);
      if (!org) throw new FlowError('FLOW_BINDING_NOT_FOUND', 404);
      return transact(org, async tx => {
        const b = await binding(tx, org, id);
        if (!verifyChatwootSignature(credentials(b).secret, raw, timestamp, signature)) throw new FlowError('FLOW_SIGNATURE_INVALID', 401);
        if (b.status !== 'READY') return { accepted: false };
        await context(tx, b);
        let payload: unknown;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new FlowError('INVALID_REQUEST', 400); }
        const event = parseFlowChatwootEvent(payload, { accountId: Number(b.account_id), inboxId: Number(b.inbox_id), botId: Number(b.bot_id) });
        if (!event) return { accepted: false };
        if (event.kind === 'HUMAN') { await pause(tx, org, id, event.conversationId); return { accepted: true }; }
        const queued = (await tx.query("select count(*)::int n from flow_chatwoot_events where organization_id=$1 and status='PENDING'", [org])).rows[0].n;
        if (queued >= 10000) throw new FlowError('FLOW_QUEUE_FULL', 429);
        await tx.query(`insert into flow_chatwoot_events(organization_id,binding_id,conversation_id,message_id,payload) values($1,$2,$3,$4,$5)
          on conflict(organization_id,binding_id,message_id) do nothing`, [org, id, event.conversationId, event.messageId, JSON.stringify(event)]);
        return { accepted: true };
      });
    },
    runs: (org: string, flowId: string) => transact(org, async tx => {
      await feature(tx, org);
      return { data: (await tx.query(`select e.id,e.conversation_id as "conversationId",e.status,e.version,e.trace,e.last_error as "errorCode",e.created_at as "createdAt",
        b.name as "inboxName",(select jsonb_agg(jsonb_build_object('id',o.id,'status',o.status,'errorCode',o.last_error) order by o.ordinal)
          from flow_chatwoot_outbox o where o.organization_id=e.organization_id and o.event_id=e.id) as deliveries
        from flow_chatwoot_events e join flow_chatwoot_bindings b on b.organization_id=e.organization_id and b.id=e.binding_id
        where e.organization_id=$1 and b.flow_id=$2 order by e.created_at desc limit 100`, [org, flowId])).rows };
    }),
    async runOnce(org: string) {
      // Pure execution, state and durable output are one transaction. No sending before commit.
      await transact(org, async tx => {
        if (!(await tx.query("select pg_try_advisory_xact_lock(hashtextextended('flow-worker:'||$1,0)) as locked", [org])).rows[0].locked) return;
        const e = (await tx.query<EventRow>(`select e.* from flow_chatwoot_events e where e.organization_id=$1 and e.status='PENDING' and e.available_at<=now()
          and not exists(select 1 from flow_chatwoot_events prev where prev.organization_id=e.organization_id and prev.binding_id=e.binding_id
            and prev.conversation_id=e.conversation_id and (prev.created_at,prev.id)<(e.created_at,e.id) and prev.status in ('PENDING','FAILED'))
          order by e.created_at,e.id limit 1`, [org])).rows[0];
        if (!e) return;
        const b = await binding(tx, org, e.binding_id);
        // The webhook also locks binding first; never invert the lock order during human takeover.
        if (!(await tx.query("select 1 from flow_chatwoot_events where organization_id=$1 and id=$2 and status='PENDING' for update", [org,e.id])).rowCount) return;
        try {
          const a = await context(tx, b);
          if (b.status !== 'READY') throw new FlowError('FLOW_BINDING_DISABLED', 409);
          const session = (await tx.query<{ version: number; state: FlowState; human: boolean }>('select * from flow_chatwoot_sessions where organization_id=$1 and binding_id=$2 and conversation_id=$3 for update', [org, b.id, e.conversation_id])).rows[0];
          if (session?.human || !await canonical(a, b, Number(e.conversation_id))) { await pause(tx, org, b.id, e.conversation_id); return; }
          const version = session?.version ?? (await tx.query('select published_version from flows where organization_id=$1 and id=$2', [org, b.flow_id])).rows[0].published_version;
          const graph = (await tx.query<{ graph: FlowGraph }>('select graph from flow_versions where organization_id=$1 and flow_id=$2 and version=$3', [org, b.flow_id, version])).rows[0]!.graph;
          const result = executeFlow(graph, { text: e.payload.text, variables: { 'contact.name': e.payload.name }, ...(session?.state ? { state: session.state } : {}) });
          const state = { status: result.status, nodeId: result.nodeId, variables: result.variables, steps: result.steps };
          await tx.query(`insert into flow_chatwoot_sessions(organization_id,binding_id,conversation_id,version,state) values($1,$2,$3,$4,$5)
            on conflict(organization_id,binding_id,conversation_id) do update set version=$4,state=$5,updated_at=now()`, [org, b.id, e.conversation_id, version, JSON.stringify(state)]);
          await tx.query("update flow_chatwoot_events set status='DONE',version=$3,trace=$4 where organization_id=$1 and id=$2", [org, e.id, version, JSON.stringify(result.trace)]);
          for (const [ordinal, text] of result.texts.entries()) await tx.query(`insert into flow_chatwoot_outbox(organization_id,binding_id,event_id,conversation_id,ordinal,kind,content)
            values($1,$2,$3,$4,$5,'TEXT',$6)`, [org, b.id, e.id, e.conversation_id, ordinal, text]);
          if (result.status === 'handoff') await tx.query(`insert into flow_chatwoot_outbox(organization_id,binding_id,event_id,conversation_id,ordinal,kind,content)
            values($1,$2,$3,$4,$5,'HANDOFF','')`, [org, b.id, e.id, e.conversation_id, result.texts.length]);
        } catch (err) {
          // A failing conversation retains its order without starving the company's other conversations.
          const retry = err instanceof ChatwootError && err.retrySafe && e.attempts < 4;
          await tx.query(`update flow_chatwoot_events set status=$3,last_error=$4,attempts=attempts+1,available_at=now()+interval '30 seconds'
            where organization_id=$1 and id=$2`, [org, e.id, retry ? 'PENDING' : 'FAILED', errorCode(err)]);
        }
      });
      await service.deliverOnce(org);
    },
    async deliverOnce(org: string) {
      const output = await transact(org, async tx => {
        await tx.query("update flow_chatwoot_outbox set status='UNKNOWN',last_error='FLOW_SEND_INTERRUPTED' where organization_id=$1 and status='SENDING' and lease_expires_at<now()", [org]);
        const row = (await tx.query<Output>(`select o.* from flow_chatwoot_outbox o where o.organization_id=$1 and o.status='PENDING' and o.available_at<=now()
          and not exists(select 1 from flow_chatwoot_outbox prev where prev.organization_id=o.organization_id and prev.binding_id=o.binding_id and prev.conversation_id=o.conversation_id
            and (prev.created_at,prev.event_id,prev.ordinal)<(o.created_at,o.event_id,o.ordinal) and prev.status not in ('SENT','CANCELED'))
          order by o.created_at,o.event_id,o.ordinal limit 1 for update skip locked`, [org])).rows[0];
        if (!row) return null;
        await tx.query("update flow_chatwoot_outbox set status='SENDING',attempts=attempts+1,lease_expires_at=now()+interval '2 minutes' where organization_id=$1 and id=$2", [org, row.id]);
        return row;
      });
      if (!output) return;
      // A committed SENDING claim makes crashes visible as UNKNOWN, never an automatic duplicate.
      await transact(org, async tx => {
        const b = await binding(tx, org, output.binding_id);
        const row = (await tx.query("select status from flow_chatwoot_outbox where organization_id=$1 and id=$2 for update", [org, output.id])).rows[0];
        if (row?.status !== 'SENDING') return;
        try {
          const a = await context(tx, b);
          const human = (await tx.query('select human from flow_chatwoot_sessions where organization_id=$1 and binding_id=$2 and conversation_id=$3', [org, b.id, output.conversation_id])).rows[0]?.human;
          if (b.status !== 'READY' || human || !await canonical(a, b, Number(output.conversation_id))) throw new FlowError('FLOW_HUMAN_TAKEOVER', 409);
          const client = botClient(a, b);
          const remoteId = output.kind === 'TEXT' ? await client.sendFlowMessage(Number(b.account_id), Number(output.conversation_id), output.content, output.id) : null;
          if (output.kind === 'HANDOFF') { await client.handoffFlowConversation(Number(b.account_id), Number(output.conversation_id)); await pause(tx, org, b.id, output.conversation_id); }
          await tx.query("update flow_chatwoot_outbox set status='SENT',remote_message_id=$3,lease_expires_at=null where organization_id=$1 and id=$2", [org, output.id, remoteId]);
        } catch (err) {
          const uncertain = err instanceof ChatwootError && err.uncertain;
          const retry = err instanceof ChatwootError && err.retrySafe && output.attempts < 4;
          await tx.query(`update flow_chatwoot_outbox set status=$3,last_error=$4,lease_expires_at=null,available_at=now()+interval '30 seconds'
            where organization_id=$1 and id=$2`, [org, output.id, uncertain ? 'UNKNOWN' : retry ? 'PENDING' : err instanceof FlowError ? 'CANCELED' : 'FAILED', errorCode(err)]);
        }
      });
    },
  };
  return service;
}
