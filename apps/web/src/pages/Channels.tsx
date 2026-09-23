import { useCallback, useLayoutEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ChannelV1 } from '@jrc/contracts';
import { ApiClientError } from '../api/client.js';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { listChannels } from '../channels/api.js';

const labels = { QR: 'WhatsApp por QR Code', META: 'WhatsApp oficial Meta' } as const;
const statusLabel: Record<string, string> = {
  CREATED: 'Criado', PAIRING: 'Aguardando pareamento', CONNECTED: 'Conectado', DISCONNECTED: 'Desconectado',
  DEGRADED: 'Com falha', UNKNOWN: 'Indisponível', PENDING: 'Pendente', READY: 'Pronto', REVOKED: 'Revogado',
  DISABLED: 'Desativado', UNBOUND: 'Não vinculado', DRAFT: 'Rascunho', ACTIVE: 'Ativo', PAUSED: 'Pausado', ERROR: 'Erro',
};

export function ChannelsPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const [items, setItems] = useState<ChannelV1[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');const [showArchived,setShowArchived]=useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');setItems([]);
    try { const result=await listChannels(client,showArchived);if(!signal?.aborted)setItems(result.data); }
    catch (caught) { if (!signal?.aborted) setError(caught instanceof ApiClientError ? caught.message : 'Não foi possível carregar os canais.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [client,showArchived]);
  useLayoutEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); },
    [load, session?.activeOrganization.id, tenantRevision]);
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
          <div className="metric"><small>JRC Conversas / Chatwoot</small><strong>{item.destination?.name??'Sem caixa vinculada'}</strong><span>{statusLabel[item.humanStatus]}</span></div>
        </div>
        <details><summary>Detalhes técnicos</summary><p>Serviço WhatsApp: {statusLabel[item.providerStatus]} · Atualizado em {new Date(item.updatedAt).toLocaleString('pt-BR')}</p></details>
      </article>)}
    </div>
  </section>;
}

export { statusLabel };
