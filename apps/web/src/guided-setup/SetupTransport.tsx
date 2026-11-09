import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelV1, ConnectionAction, GuidedSetup, SetupSelection } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { NewConnectionPage } from '../pages/NewConnection.js';
import { MetaConnectPage } from '../pages/MetaConnect.js';
import { pairChannel, refreshChannelStatus } from '../channels/api.js';
import { ChallengePanel } from '../connections/components/ChallengePanel.js';
import { setupChannels } from './resources.js';
import { setupError } from './useGuidedSetup.js';

export function SetupTransport({ client, row, disabled, save }: { client: ApiClient; row: GuidedSetup; disabled: boolean;
  save(selection: SetupSelection): Promise<unknown> | null }) {
  const [items, setItems] = useState<ChannelV1[]>([]), [selected, setSelected] = useState(row.selection.channelId ?? '');
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [action, setAction] = useState<ConnectionAction | null>(null), [reload, setReload] = useState(0);
  const generation = useRef(0), pairKey = useRef<string | null>(null);
  useEffect(() => { setSelected(row.selection.channelId ?? ''); }, [row.selection.channelId]);
  useEffect(() => {
    const current = ++generation.current, abort = new AbortController(); setItems([]); setAction(null); setError(''); pairKey.current = null;
    void setupChannels(client, row.organizationId, abort.signal).then(channels => {
      if (current === generation.current) setItems(channels.filter(channel => channel.provider === row.selection.transport));
    }).catch(reason => { if (!abort.signal.aborted && current === generation.current) setError(setupError(reason)); });
    return () => { generation.current++; abort.abort(); setAction(null); };
  }, [client, row.organizationId, row.selection.transport, reload]);
  const selectionFor = useCallback((id: string): SetupSelection => {
    if (id === row.selection.channelId) return { ...row.selection };
    const { integrationId: _integration, agentIds: _agents, humanTarget: _target, ...selection } = row.selection;
    return { ...selection, channelId: id };
  }, [row.selection]);
  const channel = items.find(item => item.id === selected);
  async function pair() {
    if (!channel || busy || disabled) return;
    const current = generation.current; setBusy(true); setError(''); pairKey.current ??= crypto.randomUUID();
    try {
      const response = await pairChannel(client, channel.id, pairKey.current);
      if (current !== generation.current) return;
      setAction(response.action); setItems(old => old.map(item => item.id === channel.id ? response.channel : item));
    } catch (reason) { if (current === generation.current) setError(setupError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function refresh() {
    if (!channel || busy) return;
    const current = generation.current; setBusy(true); setError('');
    try {
      const updated = await refreshChannelStatus(client, channel.id);
      if (current !== generation.current) return;
      setItems(old => old.map(item => item.id === channel.id ? updated : item));
      if (updated.transportStatus === 'CONNECTED') { setAction(null); pairKey.current = null; }
    } catch (reason) { if (current === generation.current) setError(setupError(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="panel"><h3>WhatsApp</h3><p>{row.selection.transport === 'QR' ? 'Conexão por QR Code' : 'Conexão oficial Meta'}</p>
    {error && <p role="alert">{error}</p>}
    <label>WhatsApp desta empresa<select disabled={disabled || busy} value={selected} onChange={event => { setSelected(event.target.value); setAction(null); pairKey.current = null; }}>
      <option value="">Selecione pelo nome</option>{items.map(item => <option key={item.id} value={item.id}>{item.identity.displayName ?? 'WhatsApp'}{item.identity.maskedAddress ? ` · ${item.identity.maskedAddress}` : ''}</option>)}
    </select></label>
    <button className="button button--primary" disabled={disabled || busy || !selected} onClick={() => void save(selectionFor(selected))}>Salvar conexão</button>
    <button className="button button--secondary" disabled={busy} onClick={() => setReload(value => value + 1)}>Atualizar lista</button>
    <button className="button button--secondary" disabled={disabled || busy} onClick={() => setCreating(value => !value)}>{creating ? 'Fechar nova conexão' : 'Conectar novo WhatsApp'}</button>
    {channel && <div><p>Conexão: {channel.transportStatus === 'CONNECTED' ? 'Conectado' : 'Aguardando conexão'}</p>
      <button className="button button--secondary" disabled={busy} onClick={() => void refresh()}>Atualizar estado do WhatsApp</button>
      {channel.provider === 'QR' && channel.transportStatus !== 'CONNECTED' && <button className="button button--secondary" disabled={disabled || busy} onClick={() => void pair()}>Ler QR Code</button>}
    </div>}
    {action && <ChallengePanel action={action} onExpire={() => { setAction(null); pairKey.current = null; }} />}
    {creating && (row.selection.transport === 'META' ? <MetaConnectPage /> : <NewConnectionPage canonical onCreated={async id => {
      setSelected(id); setCreating(false); setReload(value => value + 1); await save(selectionFor(id));
    }} />)}
  </section>;
}
