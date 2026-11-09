import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatwootStatusSchema, type AttendanceCatalog, type ChatwootStatus, type GuidedSetup, type SetupSelection } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { ChatwootPanel, type IntegrationRequest } from '../integrations/ChatwootPanel.js';
import { getHandoffCatalog } from '../automations/api.js';
import { getChannel } from '../channels/api.js';
import { setupError } from './useGuidedSetup.js';

export function SetupConnections({ client, row, companyName, disabled, save }: { client: ApiClient; row: GuidedSetup; companyName: string; disabled: boolean;
  save(selection: SetupSelection): Promise<unknown> | null }) {
  const [status, setStatus] = useState<ChatwootStatus | null>(null), [canonical, setCanonical] = useState<string | null>(null);
  const [integration, setIntegration] = useState(row.selection.integrationId ?? ''), [catalog, setCatalog] = useState<AttendanceCatalog | null>(null);
  const [agents, setAgents] = useState<number[]>(row.selection.agentIds ?? []), [target, setTarget] = useState('');
  const [open, setOpen] = useState(false), [reload, setReload] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const request = useCallback<IntegrationRequest>((path, method = 'GET', body, options) => client.request(`/v1/integrations/chatwoot${path}`, {
    method, ...(options ? { headers: { 'Idempotency-Key': options.idempotencyKey } } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), [client]);
  useEffect(() => {
    setIntegration(row.selection.integrationId ?? ''); setAgents(row.selection.agentIds ?? []);
    const chosen = row.selection.humanTarget;
    setTarget(chosen?.agentId ? `agent:${chosen.agentId}` : chosen?.teamId ? `team:${chosen.teamId}` : '');
  }, [row.revision, row.selection]);
  useEffect(() => {
    const current = ++generation.current, abort = new AbortController(); setError(''); setCatalog(null); setStatus(null);
    void (async () => {
      const [raw, channel] = await Promise.all([client.request('/v1/integrations/chatwoot', { signal: abort.signal }),
        row.selection.channelId ? getChannel(client, row.selection.channelId) : Promise.resolve(null)]);
      const next = ChatwootStatusSchema.parse(raw);
      if (next.destination && next.destination.organizationId !== row.organizationId || channel && channel.organizationId !== row.organizationId)
        throw new ApiClientError('A caixa não corresponde à empresa atual.', 409);
      if (current !== generation.current) return;
      setStatus(next); setCanonical(channel?.messagingChannelId ?? null);
      if (integration && channel?.messagingChannelId) {
        const observed = await getHandoffCatalog(client, row.organizationId, integration, abort.signal);
        if (observed.scope.channelId !== channel.messagingChannelId) throw new ApiClientError('O catálogo não corresponde ao WhatsApp selecionado.', 409);
        if (current === generation.current) setCatalog(observed);
      }
    })().catch(reason => { if (!abort.signal.aborted && current === generation.current) setError(setupError(reason)); });
    return () => { generation.current++; abort.abort(); };
  }, [client, row.organizationId, row.selection.channelId, integration, reload]);
  async function saveBox() {
    if (!catalog || !integration || !agents.length || !target || disabled || busy) return;
    const current = generation.current; setBusy(true); setError('');
    try {
      for (let at = 0; at < agents.length; at += 100) {
        await client.request(`/v1/integrations/chatwoot/connections/${integration}/agents`, { method: 'POST', body: JSON.stringify({ userIds: agents.slice(at, at + 100) }) });
        if (current !== generation.current) return;
      }
      const observed = await getHandoffCatalog(client, row.organizationId, integration);
      if (current !== generation.current) return;
      if (JSON.stringify(observed.scope) !== JSON.stringify(catalog.scope) || observed.credentialRevision !== catalog.credentialRevision ||
        !agents.every(id => observed.agents.some(agent => agent.id === id && agent.inboxMember))) throw new ApiClientError('O vínculo mudou ou os atendentes ainda não foram confirmados. Atualize a caixa.', 409);
      const [kind, value] = target.split(':'), id = Number(value);
      await save({ ...row.selection, integrationId: integration, agentIds: agents,
        humanTarget: kind === 'agent' ? { agentId: id, teamId: null } : { agentId: null, teamId: id } });
      if (current === generation.current) setCatalog(observed);
    } catch (reason) { if (current === generation.current) setError(setupError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="panel"><h3>Caixa e atendentes</h3>{error && <p role="alert">{error}</p>}
    <p>O vínculo utiliza a instalação, a conta e a caixa autorizadas desta empresa.</p>
    {status?.baseUrl && <p>Central: {status.baseUrl} · Conta {status.account?.accountId ?? 'pendente'}</p>}
    {!row.selection.channelId && <p>Selecione primeiro o WhatsApp na etapa anterior.</p>}
    <label>Caixa JRC deste WhatsApp<select disabled={disabled || busy} value={integration} onChange={event => { setIntegration(event.target.value); setAgents([]); setTarget(''); }}>
      <option value="">Selecione a caixa</option>{status?.connections.filter(connection => connection.channelId === canonical).map(connection =>
        <option key={connection.id} value={connection.id}>{connection.name} · Caixa {connection.inboxId ?? 'pendente'}</option>)}
    </select></label>
    <button className="button button--secondary" disabled={busy} onClick={() => setReload(value => value + 1)}>Atualizar caixas e atendentes</button>
    <button className="button button--secondary" disabled={disabled || busy} onClick={() => setOpen(value => !value)}>{open ? 'Fechar configuração da central' : 'Criar ou adotar caixa JRC'}</button>
    {open && <ChatwootPanel companyName={companyName} platform={false} canManage={!disabled} request={request} />}
    {catalog && <fieldset disabled={disabled || busy}><legend>Atendentes disponíveis nesta conta</legend>
      {catalog.agents.map(agent => <label key={agent.id}><input type="checkbox" aria-label={agent.name} checked={agents.includes(agent.id)}
        onChange={event => setAgents(values => event.target.checked ? [...values, agent.id] : values.filter(id => id !== agent.id))} />
        {agent.name} <small>{agent.inboxMember ? 'Já participa da caixa' : 'Será vinculado à caixa'}</small></label>)}
      <label>Destino do atendimento humano<select value={target} onChange={event => setTarget(event.target.value)}>
        <option value="">Selecione pelo nome</option>{catalog.agents.filter(agent => agents.includes(agent.id)).map(agent => <option key={`agent:${agent.id}`} value={`agent:${agent.id}`}>{agent.name}</option>)}
        {catalog.teams.map(team => <option key={`team:${team.id}`} value={`team:${team.id}`}>{team.name} · Equipe</option>)}
      </select></label>
      <button className="button button--primary" disabled={!agents.length || !target || busy} onClick={() => void saveBox()}>Salvar caixa e atendentes</button>
    </fieldset>}
  </section>;
}
