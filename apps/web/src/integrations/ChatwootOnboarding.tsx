import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ControlResourcesSchema, OnboardingListSchema, OnboardingOperationSchema, type OnboardingInput, type OnboardingOperation } from '@jrc/contracts';
import type { IntegrationRequest } from './ChatwootPanel.js';

const stages: Record<OnboardingOperation['stage'], string> = {
  INSTANCE: 'Preparar WhatsApp', ACTIVATE_CHANNEL: 'Preparar recebimento', LINK_INBOX: 'Vincular caixa de destino',
  ASSIGN_AGENTS: 'Vincular atendentes', VERIFY: 'Conferir configuração', DONE: 'Configuração concluída',
};
const states: Record<OnboardingOperation['state'], string> = {
  PENDING: 'Aguardando processamento', RUNNING: 'Em processamento', FAILED: 'Precisa de correção',
  UNKNOWN: 'Resultado a conferir', SUCCEEDED: 'Vínculo configurado',
};

/** Progress is read from durable operations. QR challenges and credentials are never cached. */
export function ChatwootOnboarding({ request }: { request: IntegrationRequest }) {
  const api = useRef(request); api.current = request;
  const live = useRef(false), mutation = useRef(false), revision = useRef(0);
  const intent = useRef<{ key: string; input: OnboardingInput } | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const [resources, setResources] = useState<ReturnType<typeof ControlResourcesSchema.parse> | null>(null);
  const [operations, setOperations] = useState<OnboardingOperation[]>([]);
  const [source, setSource] = useState(''), [name, setName] = useState('');
  const [provider, setProvider] = useState(''), [instanceName, setInstanceName] = useState('');
  async function load() {
    const current = ++revision.current;
    setLoading(true);
    try {
      const [rawResources, rawOperations] = await Promise.all([
        api.current('/control/resources'), api.current('/control/onboarding'),
      ]);
      const choices = ControlResourcesSchema.parse(rawResources), progress = OnboardingListSchema.parse(rawOperations);
      if (!live.current || current !== revision.current) return;
      setResources(choices); setOperations(progress.data); setError('');
    } catch {
      if (live.current && current === revision.current) setError('Não foi possível consultar a configuração. Atualize antes de iniciar outro vínculo.');
    } finally { if (live.current && current === revision.current) setLoading(false); }
  }
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; revision.current++; intent.current = null; };
  }, []);
  useEffect(() => { if (open) void load(); }, [open]);
  useEffect(() => {
    if (!open || !operations.some(item => ['PENDING', 'RUNNING'].includes(item.state))) return;
    const timer = setInterval(() => { if (!mutation.current) void load(); }, 5000);
    return () => clearInterval(timer);
  }, [open, operations]);
  const unfinished = operations.filter(item => item.state !== 'SUCCEEDED' && item.lastError !== 'ONBOARDING_CANCELLED');
  async function start(event: FormEvent) {
    event.preventDefault();
    if (mutation.current || !resources || unfinished.length || !name.trim() || (error && !uncertain)) return;
    if (!intent.current) intent.current = { key: crypto.randomUUID(), input: { name: name.trim(),
      source: source === 'NEW' ? { kind: 'NEW', instanceName: instanceName.trim(), providerAccountId: provider }
        : { kind: 'EXISTING', instanceId: source }, agentIds: [], replaceExistingWebhook: false } };
    mutation.current = true; setBusy(true); setError('');
    try {
      const result = OnboardingOperationSchema.parse(await api.current('/control/onboarding', 'POST', intent.current.input,
        { idempotencyKey: intent.current.key }));
      if (!live.current) return;
      setOperations(previous => [result, ...previous.filter(item => item.operationId !== result.operationId)]);
      intent.current = null; setUncertain(false);
    } catch {
      if (live.current) { setUncertain(true); setError('A solicitação não foi confirmada. Consulte a mesma solicitação antes de alterar os dados ou iniciar outra.'); }
    } finally { mutation.current = false; if (live.current) setBusy(false); }
  }
  async function recover(operation: OnboardingOperation) {
    if (mutation.current) return;
    mutation.current = true; setBusy(true); setError('');
    try {
      const result = OnboardingOperationSchema.parse(await api.current(`/control/onboarding/${operation.operationId}/recover`, 'POST',
        { action: operation.state === 'UNKNOWN' ? 'RECONCILE' : 'RETRY' }, { idempotencyKey: crypto.randomUUID() }));
      if (live.current) setOperations(previous => previous.map(item => item.operationId === result.operationId ? result : item));
    } catch { if (live.current) setError('Não foi possível confirmar a retomada. Atualize o andamento antes de tentar novamente.'); }
    finally { mutation.current = false; if (live.current) setBusy(false); }
  }
  return <section className="panel">
    <h3>Configuração guiada de WhatsApp por QR Code</h3>
    <p>Crie uma caixa API usando um WhatsApp existente ou prepare uma nova conexão. O andamento é salvo no servidor para retomar após recarregar esta tela. Para Meta ou adoção de caixa existente, use Caixas e conexões abaixo.</p>
    <button className="button button--secondary" onClick={() => setOpen(value => !value)}>{open ? 'Fechar configuração guiada' : 'Abrir configuração guiada'}</button>
    {open && <>
      <button className="button button--secondary" disabled={busy || loading} onClick={() => void load()}>Atualizar andamento</button>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Consultando configurações salvas…</p>}
      {operations.map(item => <article className="integration-provision" key={item.operationId}>
        <strong>{states[item.state]}</strong><p>Etapa: {stages[item.stage]}</p>
        {item.inboxId && <p>Caixa de destino: {item.inboxId}</p>}
        <small>Operação: {item.operationId}</small>
        {['UNKNOWN', 'FAILED'].includes(item.state) && item.lastError !== 'ONBOARDING_CANCELLED' &&
          <button className="button button--secondary" disabled={busy || loading} onClick={() => void recover(item)}>
            {item.state === 'UNKNOWN' ? 'Conferir e retomar' : 'Retomar configuração'}</button>}
        {item.state === 'SUCCEEDED' && <p>Use Atualizar integração no topo desta página e abra o controle de conexões, leia o QR Code e confirme o número. A entrega só será comprovada após o teste de mensagem e resposta.</p>}
      </article>)}
      {resources && !unfinished.length && <form className="integration-form" onSubmit={event => void start(event)}>
        <fieldset disabled={busy || loading || uncertain}><legend>Nova caixa de destino</legend>
          <label>WhatsApp para vincular<select required value={source} onChange={event => setSource(event.target.value)}>
            <option value="">Selecione uma conexão</option>
            {resources.instances.filter(item => !resources.connections.some(connection => connection.instanceId === item.id)).map(item =>
              <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value="NEW">Criar uma conexão WhatsApp</option>
          </select></label>
          {source === 'NEW' && <><label>Nome do WhatsApp<input required maxLength={100} value={instanceName} onChange={event => setInstanceName(event.target.value)} /></label>
            <label>Conta de conexão<select required value={provider} onChange={event => setProvider(event.target.value)}>
              <option value="">Selecione</option>{resources.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label></>}
          <label>Nome da caixa na central<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
          <p>Depois do vínculo, selecione os agentes em Atendentes desta caixa.</p>
        </fieldset>
        <button className="button button--primary" disabled={busy || loading || Boolean(error && !uncertain) || !source || !name.trim() || (source === 'NEW' && (!provider || !instanceName.trim()))}>
          {uncertain ? 'Consultar solicitação anterior' : 'Criar vínculo guiado'}</button>
      </form>}
    </>}
  </section>;
}
