import { useEffect, useRef, useState } from 'react';
import type { ChannelV1 } from '@jrc/contracts';
import type { IntegrationRequest } from '../integrations/ChatwootPanel.js';
import { statusLabel, destinationStatusLabel } from '../pages/Channels.js';
import { ApiClientError } from '../api/client.js';
import { ChannelDeletion } from '../channels/ChannelDeletion.js';

const stalledCursor = 'A lista de caixas não avançou. Atualize e tente novamente.';

export function CompanyChannels({ request, admin, disabled }: {
  request: IntegrationRequest;
  admin: boolean;
  disabled: boolean;
}) {
  const [items, setItems] = useState<ChannelV1[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string>();
  const api = useRef(request);
  const generation = useRef(0);
  const seen = useRef(new Set<string>());
  api.current = request;

  async function page(cursor?: string) {
    return await api.current(cursor ? `?cursor=${encodeURIComponent(cursor)}` : '') as {
      data: ChannelV1[];
      nextCursor?: string;
    };
  }

  async function refresh() {
    const version = ++generation.current;
    setLoading(true);
    setLoadingMore(false);
    setItems([]);
    setNextCursor(undefined);
    setError('');
    seen.current = new Set();
    try {
      const first = await page();
      if (version !== generation.current) return;
      setItems(first.data);
      setNextCursor(first.nextCursor);
      if (first.nextCursor) seen.current.add(first.nextCursor);
    } catch {
      if (version === generation.current) setError('Não foi possível consultar as caixas desta empresa.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, []);

  async function loadMore() {
    if (!nextCursor || loading || loadingMore || busy) return;
    const version = generation.current;
    setLoadingMore(true);
    setError('');
    try {
      const result = await page(nextCursor);
      if (version !== generation.current) return;
      if (result.nextCursor && seen.current.has(result.nextCursor)) {
        setNextCursor(undefined);
        setError(stalledCursor);
        return;
      }
      if (result.nextCursor) seen.current.add(result.nextCursor);
      setItems(current => {
        const ids = new Set(current.map(item => item.id));
        return [...current, ...result.data.filter(item => !ids.has(item.id))];
      });
      setNextCursor(result.nextCursor);
    } catch {
      if (version === generation.current) setError('Não foi possível carregar mais caixas. Tente novamente.');
    } finally {
      if (version === generation.current) setLoadingMore(false);
    }
  }

  async function archive(item: ChannelV1) {
    if (busy || !window.confirm(item.archivedAt
      ? 'Restaurar este cadastro? Vínculos e conexão não serão ativados automaticamente.'
      : 'Arquivar este cadastro? A operação exige WhatsApp desconectado, vínculos desativados e ausência de pendências. O histórico será preservado.')) return;
    setBusy(true);
    setError('');
    try {
      await api.current(`/${item.id}/archive`, 'POST', { archived: !item.archivedAt });
      await refresh();
    } catch (reason) {
      const code = reason instanceof ApiClientError ? reason.code : '';
      setError(({
        CHANNEL_DISCONNECT_REQUIRED: 'Desconecte o WhatsApp no portal da empresa antes de arquivar.',
        CHANNEL_UNLINK_REQUIRED: 'Desvincule a automação e pause o atendimento no portal.',
        CHANNEL_HAS_PENDING_WORK: 'Conclua ou cancele as operações pendentes antes de arquivar.',
      } as Record<string, string>)[code ?? ''] ??
        'Não foi possível alterar o cadastro. Confira as pendências e tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel">
    <h2>Caixas de entrada da empresa</h2>
    <p>Consulta e alterações vinculadas ao motivo de suporte informado. O histórico e as caixas remotas são preservados.</p>
    <button className="button button--ghost" disabled={loading || loadingMore || busy || disabled} onClick={() => void refresh()}>Atualizar caixas</button>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Carregando caixas…</p> : items.length ? <div className="admin-table-scroll"><table>
      <thead><tr><th>Caixa</th><th>WhatsApp</th><th>Atendimento</th><th>Cadastro</th>{admin && <th>Ações</th>}</tr></thead>
      <tbody>{items.map(item => <tr key={item.id}>
        <td>{item.identity.displayName}<small>{item.provider === 'QR' ? 'WhatsApp QR Code' : 'WhatsApp oficial Meta'}</small></td>
        <td>{statusLabel[item.transportStatus]}</td>
        <td>{item.destination?.name ?? 'Sem vínculo'}<small>{item.humanStatus ? destinationStatusLabel(item.humanStatus) : 'Entrega a verificar'}</small></td>
        <td>{item.archivedAt ? 'Arquivado' : 'Ativo'}</td>
        {admin && <td>{item.provider === 'QR'
          ? <button className="button button--secondary" disabled={busy || disabled} onClick={() => void archive(item)}>{item.archivedAt ? 'Restaurar cadastro' : 'Arquivar cadastro'}</button>
          : <span>Revogar autorização no portal</span>}<ChannelDeletion request={request} path={`/${item.id}`} disabled={busy || disabled} onCompleted={()=>void refresh()}/></td>}
      </tr>)}</tbody>
    </table></div> : error ? null : <p>Nenhuma caixa cadastrada.</p>}
    {nextCursor && !loading && <button className="button button--secondary" disabled={loadingMore || busy || disabled} onClick={() => void loadMore()}>{loadingMore ? 'Carregando mais caixas…' : 'Carregar mais caixas'}</button>}
  </section>;
}
