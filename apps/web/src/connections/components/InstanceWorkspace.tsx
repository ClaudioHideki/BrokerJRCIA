import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useApiClient, useSession } from '../../auth/SessionProvider.js';
import './instance-workspace.css';

type Settings = { rejectCall: boolean; msgCall: string; groupsIgnore: boolean; alwaysOnline: boolean; readMessages: boolean; readStatus: boolean; syncFullHistory: boolean };
type Workspace = {
  observedAt: string; providerAvailable: boolean;
  profile: { name: string | null; phone: string | null; state: string | null };
  counts: { contacts: number | null; chats: number | null; messages: number | null };
  settings: Settings | null;
  operations: { id: string; type: string; status: string; attempts: number; errorCode: string | null; updatedAt: string }[];
  instance: { id: string; name: string; status: string; createdAt: string; updatedAt: string };
};
const toggles = [
  ['rejectCall', 'Rejeitar chamadas', 'Recusa chamadas recebidas neste WhatsApp.'],
  ['groupsIgnore', 'Ignorar grupos', 'Ignora eventos de mensagens de grupos.'],
  ['alwaysOnline', 'Manter online', 'Mantém a presença online enquanto a sessão estiver ativa.'],
  ['readMessages', 'Marcar mensagens como lidas', 'Envia confirmação de leitura para mensagens recebidas.'],
  ['readStatus', 'Marcar status como vistos', 'Registra a visualização de atualizações de status.'],
  ['syncFullHistory', 'Sincronizar histórico completo', 'Solicita ao WhatsApp o histórico disponível; não garante todo o histórico do celular.'],
] as const;

function isWorkspace(value: unknown, id: string): value is Workspace {
  if (!value || typeof value !== 'object') return false;
  const data = value as Workspace;
  const nullableString = (item: unknown) => item === null || typeof item === 'string';
  return typeof data.observedAt === 'string' && typeof data.providerAvailable === 'boolean'
    && data.instance?.id === id && typeof data.instance.createdAt === 'string' && typeof data.instance.updatedAt === 'string'
    && !!data.profile && ['name', 'phone', 'state'].every((key) => nullableString(data.profile[key as keyof Workspace['profile']]))
    && !!data.counts && ['contacts', 'chats', 'messages'].every((key) => { const count = data.counts[key as keyof Workspace['counts']]; return count === null || (Number.isSafeInteger(count) && count >= 0); })
    && (data.settings === null || (!!data.settings && typeof data.settings.msgCall === 'string' && toggles.every(([key]) => typeof data.settings?.[key] === 'boolean')))
    && Array.isArray(data.operations) && data.operations.every((op) => !!op && typeof op.id === 'string' && typeof op.type === 'string' && typeof op.status === 'string' && Number.isSafeInteger(op.attempts) && nullableString(op.errorCode) && typeof op.updatedAt === 'string');
}
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('pt-BR'); }
const operationLabels: Record<string, string> = { CONNECT: 'Conectar', DISCONNECT: 'Desconectar', CREATE: 'Criar conexão', UPDATE_SETTINGS: 'Alterar configurações', SETTINGS_UPDATE: 'Alterar configurações', SUCCEEDED: 'Concluída', SUCCESS: 'Concluída', FAILED: 'Falhou', PENDING: 'Pendente', RUNNING: 'Em andamento', UNKNOWN: 'Resultado desconhecido' };

export function InstanceWorkspace({ instanceId }: { instanceId: string }) {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const tenantId = session?.activeOrganization.id ?? '';
  const [tab, setTab] = useState('Visão geral');
  const [data, setData] = useState<Workspace | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    setData(null); setDraft(null); setMessage(''); setLoading(true); setBusy(false);
    const unregister = client.registerTenantPurge(() => { generation.current += 1; abort.abort(); setData(null); setDraft(null); setMessage(''); setLoading(true); setBusy(false); setTab('Visão geral'); });
    void client.request<unknown>(`/v1/instances/${encodeURIComponent(instanceId)}/workspace`, { signal: abort.signal }).then((result) => {
      if (generation.current !== current || abort.signal.aborted) return;
      if (!isWorkspace(result, instanceId)) throw new Error('Invalid workspace');
      setData(result);
      setDraft(result.settings ? { rejectCall: result.settings.rejectCall, msgCall: result.settings.msgCall, groupsIgnore: result.settings.groupsIgnore, alwaysOnline: result.settings.alwaysOnline, readMessages: result.settings.readMessages, readStatus: result.settings.readStatus, syncFullHistory: result.settings.syncFullHistory } : null);
    }).catch(() => { if (generation.current === current && !abort.signal.aborted) setMessage('Painel temporariamente indisponível.'); })
      .finally(() => { if (generation.current === current && !abort.signal.aborted) setLoading(false); });
    return () => { generation.current += 1; abort.abort(); unregister(); };
  }, [client, instanceId, tenantId, tenantRevision, revision]);
  const canEdit = ['OWNER', 'ADMIN'].includes(session?.activeOrganization.role ?? '');
  async function save() {
    if (!draft || !canEdit || busy) return;
    const current = generation.current;
    setBusy(true); setMessage('');
    try {
      const result = await client.request<{ ok: boolean }>(`/v1/instances/${encodeURIComponent(instanceId)}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft), ...(controller.current ? { signal: controller.current.signal } : {}) });
      if (current !== generation.current) return;
      if (result?.ok !== true) throw new Error('Invalid settings result');
      setData((previous) => previous ? { ...previous, settings: draft } : null);
      setMessage('Configurações salvas.');
    } catch { if (current === generation.current) setMessage('Não foi possível confirmar a alteração. Atualize o painel antes de tentar novamente.'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <div className="instance-workspace">
    <div className="workspace-navigation" aria-label="Áreas da conexão">{['Visão geral', 'Configurações', 'Eventos', 'Integrações'].map((label) => <button type="button" key={label} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}</button>)}<button className="workspace-refresh" type="button" disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}>Atualizar painel</button></div>
    {message ? <p className="notice" role="status">{message}</p> : null}
    {loading ? <p aria-busy="true">Carregando painel…</p> : null}
    {tab === 'Visão geral' && data ? <>
      <div className="workspace-profile panel"><span className="workspace-avatar" aria-hidden="true">{(data.profile.name || data.instance.name || 'W').slice(0, 1).toUpperCase()}</span><div><p className="eyebrow">Perfil WhatsApp</p><h2>{data.profile.name || 'Perfil indisponível'}</h2><p>{data.profile.phone || 'Número indisponível'}</p></div><span className="workspace-provider">{data.providerAvailable ? 'Sincronização disponível' : 'Sincronização indisponível'}</span></div>
      <div className="workspace-metrics">{([['contacts', 'Contatos'], ['chats', 'Conversas'], ['messages', 'Mensagens']] as const).map(([key, label]) => <section className="panel" key={key} aria-label={`${label} ${key === 'contacts' ? 'sincronizados' : 'sincronizadas'}`}><p>{label}</p><strong>{data.counts[key] === null ? '—' : data.counts[key].toLocaleString('pt-BR')}</strong><small>Registros sincronizados</small></section>)}</div>
      <p className="workspace-help">Os indicadores representam registros sincronizados pela JRC e podem não incluir todo o histórico do celular. “—” indica informação indisponível.</p>
      <dl className="workspace-details panel"><div><dt>Criada em</dt><dd>{date(data.instance.createdAt)}</dd></div><div><dt>Última atualização da conexão</dt><dd>{date(data.instance.updatedAt)}</dd></div><div><dt>Consulta do painel</dt><dd>{date(data.observedAt)}</dd></div></dl>
    </> : null}
    {tab === 'Configurações' && !loading ? <section className="panel"><h2>Comportamento do WhatsApp</h2><p>As alterações são aplicadas à sessão desta conexão.</p>{!canEdit ? <p className="notice">Somente proprietários e administradores podem alterar estas configurações.</p> : null}{draft ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset className="workspace-settings" disabled={!canEdit || busy}>{toggles.map(([key, label, help]) => <label key={key}><input type="checkbox" checked={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} /><span><strong>{label}</strong><small>{help}</small></span></label>)}<label className="workspace-call-message"><span>Mensagem ao rejeitar chamada<small>Texto enviado quando a rejeição de chamadas estiver ativada.</small></span><textarea maxLength={1000} value={draft.msgCall} onChange={(event) => setDraft({ ...draft, msgCall: event.target.value })} /></label></fieldset>{canEdit ? <button className="button button--primary" disabled={busy || JSON.stringify(draft) === JSON.stringify(data?.settings)} type="submit">{busy ? 'Salvando…' : 'Salvar configurações'}</button> : null}</form> : <p>Configurações indisponíveis no momento. Uma integração de voz ativa no motor pode impedir a edição.</p>}</section> : null}
    {tab === 'Eventos' && !loading ? <section className="panel"><h2>Histórico operacional</h2><p>Operações recentes desta conexão. Este histórico não representa mensagens ou entregas de webhook.</p>{data?.operations.length ? <ol className="workspace-events">{data.operations.map((operation) => <li key={operation.id}><div><strong>{operationLabels[operation.type] ?? operation.type}</strong><span>{operationLabels[operation.status] ?? operation.status}</span></div><small>{date(operation.updatedAt)} · Tentativas: {operation.attempts}{operation.errorCode ? ` · Código: ${operation.errorCode}` : ''}</small></li>)}</ol> : <p>{data ? 'Nenhuma operação registrada.' : 'Histórico indisponível.'}</p>}</section> : null}
    {tab === 'Integrações' ? <section className="panel"><h2>Integrações JRC</h2><div className="workspace-integrations"><article><h3>JRC Conversas e Flows</h3><p>Vincule esta conexão a uma caixa do JRC Conversas ou de uma instalação Chatwoot aprovada. Crie o chatbot no Broker e escolha a conexão ou a caixa que ele atenderá.</p><Link to="/integracoes">Configurar integração com JRC Conversas</Link><p><Link to="/flows">Criar automação no Broker</Link></p></article><article><h3>WhatsApp oficial</h3><p>Gerencie os canais autorizados pela Meta na organização ativa.</p><Link to="/whatsapp-oficial">Gerenciar WhatsApp oficial</Link></article><article><h3>API da organização</h3><p>Gerencie as chaves e permissões de acesso à API JRC.</p><Link to="/chaves-api">Gerenciar chaves de API</Link></article></div><p className="workspace-help">A conexão com JRC Conversas depende da habilitação da empresa e da aprovação do destino. Use apenas uma automação ativa por caixa para evitar respostas duplicadas.</p></section> : null}
  </div>;
}
