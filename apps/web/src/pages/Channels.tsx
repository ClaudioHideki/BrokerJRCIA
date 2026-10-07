import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { ChannelV1 } from '@jrc/contracts';
import { ApiClientError } from '../api/client.js';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { listChannels } from '../channels/api.js';

const labels = { QR: 'WhatsApp por QR Code', META: 'WhatsApp oficial Meta',CENTRAL:'WhatsApp conectado na central' } as const;
const statusLabel: Record<string, string> = {
  CREATED: 'Criado', PAIRING: 'Aguardando pareamento', CONNECTED: 'Conectado', DISCONNECTED: 'Desconectado',
  DEGRADED: 'Com falha', UNKNOWN: 'Indisponível', PENDING: 'Pendente', READY: 'Pronto', REVOKED: 'Revogado',
  DISABLED: 'Desativado', UNBOUND: 'Não vinculado', DRAFT: 'Rascunho', ACTIVE: 'Ativo', PAUSED: 'Pausado', ERROR: 'Erro',
};
const PAGE_SIZE = 50;

export function ChannelsPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const [items, setItems] = useState<ChannelV1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');const [showArchived,setShowArchived]=useState(false);
  const generation = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    setLoading(true); setLoadingMore(false); setError('');setItems([]);setNextCursor(null);
    try { const result=await listChannels(client,showArchived,{pageSize:PAGE_SIZE});if(!signal?.aborted&&current===generation.current){setItems(result.data);setNextCursor(result.nextCursor??null);} }
    catch (caught) { if (!signal?.aborted&&current===generation.current) setError(caught instanceof ApiClientError
      ? `${caught.message}${caught.requestId ? ` Solicitação: ${caught.requestId}` : ''}`
      : 'Não foi possível carregar os canais.'); }
    finally { if (!signal?.aborted&&current===generation.current) setLoading(false); }
  }, [client,showArchived]);
  useLayoutEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => {controller.abort();generation.current++;}; },
    [load, session?.activeOrganization.id, tenantRevision]);
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);setError('');
    try {
      const result = await listChannels(client,showArchived,{pageSize:PAGE_SIZE,cursor:nextCursor});
      if (current===generation.current) {
        setItems(previous => {
          const existing = new Set(previous.map(item => item.id));
          return [...previous, ...result.data.filter(item => !existing.has(item.id))];
        });
        setNextCursor(result.nextCursor??null);
      }
    } catch (caught) {
      if (current===generation.current) setError(caught instanceof ApiClientError
        ? `${caught.message}${caught.requestId ? ` Solicitação: ${caught.requestId}` : ''}`
        : 'Não foi possível carregar mais caixas.');
    } finally { if (current===generation.current) setLoadingMore(false); }
  }
  const canManage = session?.activeOrganization.role !== 'VIEWER';
  return <section aria-labelledby="channels-title">
    <div className="page-heading"><div><p className="eyebrow">WhatsApp da sua empresa</p><h1 id="channels-title">Caixas de entrada</h1>
      <p>Conecte seu WhatsApp, escolha onde a equipe atende e ative um chatbot JRC.</p></div>
      {canManage ? <Link className="button button--primary" to="/channels/new">+ Conectar WhatsApp</Link> : null}</div>
    {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
    {loading ? <div className="state-card" aria-busy="true">Carregando canais…</div> : null}
    {!loading && !error && items.length === 0 ? <div className="state-card"><h2>Nenhum canal configurado</h2><p>Crie um canal por QR Code ou conecte uma conta oficial da Meta.</p></div> : null}
    <label><input type="checkbox" checked={showArchived} onChange={event=>setShowArchived(event.target.checked)}/> Mostrar arquivadas</label><div className="channel-cards">
      {items.map(item => <article className="panel" key={item.id}>
        <div className="page-heading"><div><p className="eyebrow">{labels[item.provider]}</p><h2>{item.identity.displayName ?? 'Canal sem nome'}</h2></div>
          <Link className="button button--secondary" to={`/channels/${item.id}`}>{item.transportStatus==='CONNECTED'?'Gerenciar caixa':'Conectar e gerenciar'}</Link></div>
        {item.archivedAt&&<p className="notice">Arquivada</p>}<p>Número: {item.identity.maskedAddress??'Ainda não identificado'}</p>
        <div className="metric-grid" aria-label="Estados da caixa de entrada">
          <div className="metric"><small>WhatsApp</small><strong>{statusLabel[item.transportStatus]}</strong></div>
          <div className="metric"><small>Automação JRC</small><strong>{item.automationName??'Nenhuma selecionada'}</strong><span>{statusLabel[item.automationStatus]}</span></div>
          <div className="metric"><small>Central de atendimento</small><strong>{item.destination?.name??'Sem caixa vinculada'}</strong><span>{destinationStatusLabel(item.humanStatus)}</span></div>
        </div>
        <details><summary>Detalhes técnicos</summary><p>Serviço WhatsApp: {statusLabel[item.providerStatus]} · Atualizado em {new Date(item.updatedAt).toLocaleString('pt-BR')}</p></details>
      </article>)}
    </div>
    {nextCursor&&!loading?<button className="button button--secondary" type="button" disabled={loadingMore} onClick={()=>void loadMore()}>
      {loadingMore?'Carregando…':'Carregar mais caixas'}</button>:null}
  </section>;
}

export { statusLabel };

export function destinationStatusLabel(status: ChannelV1['humanStatus']) {
  return status === 'READY' ? 'Vínculo configurado · entrega a verificar' : statusLabel[status];
}
