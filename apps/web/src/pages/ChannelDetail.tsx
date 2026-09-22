import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { ChannelV1, ConnectionAction } from '@jrc/contracts';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { bindChannelDestination, getChannel, pairChannel } from '../channels/api.js';
import { statusLabel } from './Channels.js';

export function ChannelDetailPage() {
  const { id = '' } = useParams(); const client = useApiClient(); const { session, tenantRevision } = useSession();
  const [channel, setChannel] = useState<ChannelV1 | null>(null); const [action, setAction] = useState<ConnectionAction | null>(null);
  const [destination, setDestination] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const controller = new AbortController(); setChannel(null); setError('');
    void getChannel(client, id).then(setChannel).catch(() => { if (!controller.signal.aborted) setError('Não foi possível carregar o canal.'); });
    return () => controller.abort(); }, [client, id, session?.activeOrganization.id, tenantRevision]);
  const canManage = session?.activeOrganization.role !== 'VIEWER';
  async function pair() { setBusy(true); setError(''); try { const result = await pairChannel(client, id, crypto.randomUUID()); setChannel(result.channel); setAction(result.action); }
    catch { setError('Não foi possível iniciar o pareamento.'); } finally { setBusy(false); } }
  async function bind(event: FormEvent) { event.preventDefault(); if (!destination.trim()) return; setBusy(true); setError('');
    try { setChannel(await bindChannelDestination(client, id, { name: destination.trim(), replaceExistingWebhook: false })); }
    catch { setError('Não foi possível vincular a caixa de atendimento.'); } finally { setBusy(false); } }
  return <section aria-labelledby="channel-detail-title"><Link className="back-link" to="/channels">← Voltar para canais</Link>
    {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
    {!channel ? <div className="state-card" aria-busy={!error}>Carregando canal…</div> : <>
      <p className="eyebrow">{channel.provider === 'QR' ? 'WhatsApp por QR Code' : 'WhatsApp oficial Meta'}</p>
      <h1 id="channel-detail-title">{channel.identity.displayName ?? 'Canal'}</h1>
      <div className="metric-grid metric-grid--four">
        <div className="metric"><small>Transporte</small><strong>{statusLabel[channel.transportStatus]}</strong></div>
        <div className="metric"><small>Provedor</small><strong>{statusLabel[channel.providerStatus]}</strong></div>
        <div className="metric"><small>Automação</small><strong>{statusLabel[channel.automationStatus]}</strong></div>
        <div className="metric"><small>Atendimento humano</small><strong>{statusLabel[channel.humanStatus]}</strong></div>
      </div>
      {channel.provider === 'QR' && canManage ? <section className="panel"><h2>Pareamento</h2><button className="button button--primary" disabled={busy} onClick={() => void pair()}>{busy ? 'Preparando…' : 'Gerar QR Code'}</button>
        {action?.type === 'QR_CODE' ? <div><p>Leia este QR Code no WhatsApp Business.</p><img className="channel-qr" src={action.value} alt="QR Code para conectar o WhatsApp" /></div> : null}
        {action?.type === 'PAIRING_CODE' ? <p className="pairing-code">Código: <strong>{action.code}</strong></p> : null}</section> : null}
      {canManage ? <form className="panel form-grid" onSubmit={event => void bind(event)}><h2>Caixa de atendimento</h2>
        <p>Vincule este canal a uma caixa do JRC Conversas ou Chatwoot autorizado.</p><label htmlFor="destination-name">Nome da caixa</label>
        <input id="destination-name" value={destination} onChange={event => setDestination(event.target.value)} required maxLength={120} />
        <button className="button button--primary" disabled={busy || !destination.trim()}>Vincular destino</button></form> : null}
      <section className="panel"><h2>Automação</h2><p>Crie ou vincule um Flow publicado para atender este canal.</p><Link to="/flows">Gerenciar JRC Flows</Link></section>
    </>}
  </section>;
}
