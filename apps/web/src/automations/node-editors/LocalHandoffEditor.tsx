import { useEffect, useState } from 'react';
import type { FlowNode } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../../api/client.js';
import { listLocalHandoffChannels } from '../api.js';

type Props = {node: FlowNode; editable: boolean; client: ApiClient; organizationId: string; onChange(data: FlowNode['data']): void};
type Channels = Awaited<ReturnType<typeof listLocalHandoffChannels>>;
export function LocalHandoffEditor({node, editable, client, organizationId, onChange}: Props) {
  const [refresh, setRefresh] = useState(0);
  const key = `${organizationId}:${node.id}:${refresh}`;
  const [state, setState] = useState<{key: string; channels: Channels; error?: string} | null>(null);
  const current = state?.key === key ? state : null;
  const destination = node.data.destination as {organizationId?: unknown; channelId?: unknown} | undefined;
  const selected = node.data.handoffVersion === 2 && destination?.organizationId === organizationId && typeof destination.channelId === 'string' ? destination.channelId : '';
  useEffect(() => {
    if (!editable || !organizationId) return;
    const controller = new AbortController();
    void listLocalHandoffChannels(client, organizationId, controller.signal).then(channels => {
      if (!controller.signal.aborted) setState({key, channels});
    }).catch(error => {
      if (!controller.signal.aborted) setState({key, channels: [], error: error instanceof ApiClientError ? error.message : 'Não foi possível consultar as caixas do Broker.'});
    });
    return () => controller.abort();
  }, [client, organizationId, editable, key]);
  if (!editable) return <p>É necessária permissão de administrador para consultar ou alterar os destinos de atendimento.</p>;
  const missing = Boolean(selected && current && !current.channels.some(item => item.scope.channelId === selected));
  return <fieldset className="automation-handoff-editor">
    <p>O bot pausa e a conversa aguarda atendimento na fila humana do Broker.</p>
    <p>Esta opção usa caixas sem uma central de atendimento vinculada.</p>
    {current === null ? <p role="status">Carregando caixas do Broker…</p> : <label>Caixa do Broker<select value={selected} disabled={Boolean(current.error)} onChange={event => {
      const item = current.channels.find(candidate => candidate.scope.channelId === event.target.value);
      if (item) onChange({handoffVersion: 2, destination: item.scope, target: {kind: 'QUEUE'}});
    }}><option value="">Selecione uma caixa</option>{missing && <option value={selected}>Caixa indisponível</option>}{current.channels.map(item => <option key={item.scope.channelId} value={item.scope.channelId}>{item.name}</option>)}</select></label>}
    {current?.error && <p role="alert">{current.error}</p>}
    {missing && !current?.error && <p role="alert">A caixa salva está indisponível neste escopo. Revise o destino antes de publicar.</p>}
    {current && !current.error && !current.channels.length && <p>Nenhuma caixa disponível para atendimento local.</p>}
    <p>O destino salvo é preservado até você selecionar uma caixa. A publicação e a execução conferem novamente o vínculo.</p>
    <button type="button" onClick={() => setRefresh(value => value + 1)}>Atualizar caixas do Broker</button>
  </fieldset>;
}
