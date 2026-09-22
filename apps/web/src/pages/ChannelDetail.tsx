import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { AutomationBindingV1, AutomationDefinitionV1, ChannelV1, ConnectionAction } from '@jrc/contracts';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { listAutomations } from '../automations/api.js';
import { bindChannelAutomation, bindChannelDestination, disconnectChannel, getChannel, getChannelAutomation,
  pairChannel, patchChannel, reconnectChannel, refreshChannelStatus } from '../channels/api.js';
import { statusLabel } from './Channels.js';

export function ChannelDetailPage() {
  const { id = '' } = useParams(); const client = useApiClient(); const { session, tenantRevision } = useSession();
  const [channel, setChannel] = useState<ChannelV1 | null>(null); const [action, setAction] = useState<ConnectionAction | null>(null);
  const [binding, setBinding] = useState<AutomationBindingV1 | null>(null);
  const [automations, setAutomations] = useState<AutomationDefinitionV1[]>([]); const [automationId, setAutomationId] = useState('');
  const [displayName, setDisplayName] = useState(''); const [destination, setDestination] = useState('');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const controller = new AbortController(); setChannel(null); setError('');
    void getChannel(client, id).then(value => { if (!controller.signal.aborted) { setChannel(value); setDisplayName(value.identity.displayName ?? ''); } })
      .catch(() => { if (!controller.signal.aborted) setError('Não foi possível carregar o canal.'); });
    void getChannelAutomation(client, id).then(value => { if (!controller.signal.aborted) { setBinding(value.binding);
      if (value.binding) setAutomationId(value.binding.automationId); } }).catch(() => undefined);
    void listAutomations(client).then(value => { if (!controller.signal.aborted) setAutomations(value.filter(item => item.activeVersion !== null)); })
      .catch(() => undefined);
    return () => controller.abort(); }, [client, id, session?.activeOrganization.id, tenantRevision]);
  const canManage = session?.activeOrganization.role !== 'VIEWER';
  async function run(operation: () => Promise<void>, failure: string) { setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch { setError(failure); } finally { setBusy(false); } }
  async function pair() { await run(async () => { const result = await pairChannel(client, id, crypto.randomUUID()); setChannel(result.channel); setAction(result.action); },
    'Não foi possível iniciar o pareamento.'); }
  async function reconnect() { await run(async () => { const result = await reconnectChannel(client, id, crypto.randomUUID());
    setChannel(result.channel); setAction(result.action); setNotice('Reconexão solicitada.'); }, 'Não foi possível reconectar o canal.'); }
  async function disconnect() { await run(async () => { const result = await disconnectChannel(client, id, crypto.randomUUID());
    setChannel(result.channel); setAction(null); setNotice(result.pending ? 'Desconexão em processamento.' : 'Canal desconectado.'); },
    'Não foi possível desconectar o canal.'); }
  async function refresh() { await run(async () => { setChannel(await refreshChannelStatus(client, id)); setNotice('Status atualizado.'); },
    'Não foi possível atualizar o status.'); }
  async function rename(event: FormEvent) { event.preventDefault(); if (!displayName.trim()) return;
    await run(async () => { setChannel(await patchChannel(client, id, { displayName: displayName.trim() })); setNotice('Nome atualizado.'); },
      'Não foi possível atualizar o nome do canal.'); }
  async function bind(event: FormEvent) { event.preventDefault(); if (!destination.trim()) return; setBusy(true); setError('');
    try { setChannel(await bindChannelDestination(client, id, { name: destination.trim(), replaceExistingWebhook: false })); }
    catch { setError('Não foi possível vincular a caixa de atendimento.'); } finally { setBusy(false); } }
  async function bindAutomation(event: FormEvent) { event.preventDefault(); if (!automationId) return;
    await run(async () => { const result = await bindChannelAutomation(client, id, { automationId }); setBinding(result.binding);
      setChannel(await getChannel(client, id)); setNotice('Automação vinculada ao canal.'); }, 'Não foi possível vincular a automação.'); }
  return <section aria-labelledby="channel-detail-title"><Link className="back-link" to="/channels">← Voltar para canais</Link>
    {error ? <div className="notice notice--error" role="alert">{error}</div> : null}
    {notice ? <div className="notice notice--success" role="status">{notice}</div> : null}
    {!channel ? <div className="state-card" aria-busy={!error}>Carregando canal…</div> : <>
      <p className="eyebrow">{channel.provider === 'QR' ? 'WhatsApp por QR Code' : 'WhatsApp oficial Meta'}</p>
      <h1 id="channel-detail-title">{channel.identity.displayName ?? 'Canal'}</h1>
      <div className="metric-grid metric-grid--four">
        <div className="metric"><small>Transporte</small><strong>{statusLabel[channel.transportStatus]}</strong></div>
        <div className="metric"><small>Provedor</small><strong>{statusLabel[channel.providerStatus]}</strong></div>
        <div className="metric"><small>Automação</small><strong>{statusLabel[channel.automationStatus]}</strong></div>
        <div className="metric"><small>Atendimento humano</small><strong>{statusLabel[channel.humanStatus]}</strong></div>
      </div>
      <section className="panel"><h2>Operação do canal</h2><div className="button-row">
        <button className="button button--secondary" disabled={busy} onClick={() => void refresh()}>Atualizar status</button>
        {channel.provider === 'QR' && canManage ? <button className="button button--secondary" disabled={busy} onClick={() => void reconnect()}>Reconectar</button> : null}
        {channel.provider === 'QR' && canManage && channel.transportStatus !== 'DISCONNECTED' ? <button className="button button--danger" disabled={busy} onClick={() => void disconnect()}>Desconectar</button> : null}
      </div></section>
      {channel.provider === 'QR' && canManage ? <section className="panel"><h2>Pareamento</h2><button className="button button--primary" disabled={busy} onClick={() => void pair()}>{busy ? 'Preparando…' : 'Gerar QR Code'}</button>
        {action?.type === 'QR_CODE' ? <div><p>Leia este QR Code no WhatsApp Business.</p><img className="channel-qr" src={action.value} alt="QR Code para conectar o WhatsApp" /></div> : null}
        {action?.type === 'PAIRING_CODE' ? <p className="pairing-code">Código: <strong>{action.code}</strong></p> : null}</section> : null}
      {channel.provider === 'QR' && canManage ? <form className="panel form-grid" onSubmit={event => void rename(event)}><h2>Identificação</h2>
        <label htmlFor="channel-display-name">Nome do canal</label><input id="channel-display-name" value={displayName}
          onChange={event => setDisplayName(event.target.value)} required maxLength={100} />
        <button className="button button--primary" disabled={busy || !displayName.trim()}>Salvar nome</button></form> : null}
      {canManage ? <form className="panel form-grid" onSubmit={event => void bind(event)}><h2>Caixa de atendimento</h2>
        <p>Vincule este canal a uma caixa do JRC Conversas ou Chatwoot autorizado.</p><label htmlFor="destination-name">Nome da caixa</label>
        <input id="destination-name" value={destination} onChange={event => setDestination(event.target.value)} required maxLength={120} />
        <button className="button button--primary" disabled={busy || !destination.trim()}>Vincular destino</button></form> : null}
      <section className="panel"><h2>Automação</h2><p>Vincule uma automação publicada do JRC ao canal.</p>
        {binding ? <p>Ativa: versão {binding.version} · revisão {binding.revision}</p> : <p>Nenhuma automação vinculada.</p>}
        {canManage ? <form className="form-grid" onSubmit={event => void bindAutomation(event)}><label htmlFor="channel-automation">Automação publicada</label>
          <select id="channel-automation" value={automationId} onChange={event => setAutomationId(event.target.value)}>
            <option value="">Selecione</option>{automations.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.activeVersion}</option>)}</select>
          <button className="button button--primary" disabled={busy || !automationId}>Vincular automação</button></form> : null}
        <Link to="/automations">Abrir Studio de Automações</Link></section>
    </>}
  </section>;
}
