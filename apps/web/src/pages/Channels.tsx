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
  const [error, setError] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try { setItems((await listChannels(client)).data); }
    catch (caught) { if (!signal?.aborted) setError(caught instanceof ApiClientError ? caught.message : 'Não foi possível carregar os canais.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [client]);
  useLayoutEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); },
    [load, session?.activeOrganization.id, tenantRevision]);
  const canManage = session?.activeOrganization.role !== 'VIEWER';
  return <section aria-labelledby="channels-title">
    <div className="page-heading"><div><p className="eyebrow">Operação omnichannel</p><h1 id="channels-title">Canais</h1>
      <p>Veja transporte, provedor, automação e atendimento humano separadamente.</p></div>
      {canManage ? <Link className="button button--primary" to="/channels/new">+ Novo canal</Link> : null}</div>
    {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
    {loading ? <div className="state-card" aria-busy="true">Carregando canais…</div> : null}
    {!loading && !error && items.length === 0 ? <div className="state-card"><h2>Nenhum canal configurado</h2><p>Crie um canal por QR Code ou conecte uma conta oficial da Meta.</p></div> : null}
    <div className="channel-cards">
      {items.map(item => <article className="panel" key={item.id}>
        <div className="page-heading"><div><p className="eyebrow">{labels[item.provider]}</p><h2>{item.identity.displayName ?? 'Canal sem nome'}</h2></div>
          <Link className="button button--secondary" to={`/channels/${item.id}`}>Gerenciar</Link></div>
        <div className="metric-grid metric-grid--four" aria-label="Estados do canal">
          <div className="metric"><small>Transporte</small><strong>{statusLabel[item.transportStatus]}</strong></div>
          <div className="metric"><small>Provedor</small><strong>{statusLabel[item.providerStatus]}</strong></div>
          <div className="metric"><small>Automação</small><strong>{statusLabel[item.automationStatus]}</strong></div>
          <div className="metric"><small>Atendimento humano</small><strong>{statusLabel[item.humanStatus]}</strong></div>
        </div>
      </article>)}
    </div>
  </section>;
}

export { statusLabel };
