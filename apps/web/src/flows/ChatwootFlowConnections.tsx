import { useState } from 'react';
import { useApiClient } from '../auth/SessionProvider.js';
import { ApiClientError } from '../api/client.js';

interface Binding { id: string; flowId: string; status: string; lastError: string | null }
interface Inbox { id: number; name: string; channelType: string; binding: Binding | null }
interface Run { id: string; inboxName: string; conversationId: number; status: string; errorCode: string | null;
  createdAt: string; deliveries: { id: string; status: string; errorCode: string | null }[] | null }
const labels: Record<string, string> = {
  CHATWOOT_NOT_CONFIGURED: 'Configure a integração JRC Conversas / Chatwoot no Broker antes de selecionar a caixa.',
  CHATWOOT_ACCOUNT_NOT_CONFIGURED: 'Vincule o ID da conta e o token de administrador em JRC Conversas / Chatwoot.',
  CHATWOOT_DESTINATION_NOT_APPROVED: 'A JRC precisa aprovar o endereço desta instalação antes da ativação.',
  FLOW_INBOX_HAS_BOT: 'Esta caixa já tem outro chatbot. Remova a associação no Chatwoot antes de ativar o Flow.',
  FLOW_CHANNEL_HAS_AUTOMATION: 'O WhatsApp desta caixa já tem uma automação direta. Desative-a antes de usar o chatbot pela caixa.',
  FLOW_INBOX_ALREADY_BOUND: 'Esta caixa já está vinculada a outro Flow. Abra esse Flow e desative o vínculo primeiro.',
  FLOW_CHATWOOT_SIGNING_REQUIRED: 'Esta instalação não fornece o segredo de assinatura do Agent Bot. A ativação exige uma versão compatível.',
  FLOW_BINDING_CHANGED: 'A configuração da empresa mudou. Desative o vínculo antigo e configure a caixa novamente.',
};
const statusLabel = (v: string) => ({ READY: 'Ativo', PENDING: 'Pendente', UNKNOWN: 'Resultado incerto — conferir no Chatwoot',
  FAILED: 'Falhou', DONE: 'Processado', PAUSED: 'Pausado', SENT: 'Entregue à API do Chatwoot', CANCELED: 'Cancelado', SENDING: 'Enviando' }[v] ?? v);

export function ChatwootFlowConnections({ flowId, published, editable }: { flowId: string; published: boolean; editable: boolean }) {
  const client = useApiClient();
  const [open, setOpen] = useState(false), [inboxes, setInboxes] = useState<Inbox[]>([]), [selected, setSelected] = useState('');
  const [account, setAccount] = useState<number>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [runs, setRuns] = useState<Run[] | null>(null);
  async function load() {
    const data = await client.request<{ accountId: number; data: Inbox[] }>('/v1/flows/chatwoot/inboxes');
    setAccount(data.accountId); setInboxes(data.data); setSelected(v => data.data.some(i => String(i.id) === v) ? v : String(data.data[0]?.id ?? ''));
  }
  async function action(work: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof ApiClientError ? labels[e.code ?? ''] ?? e.message : 'Não foi possível concluir a configuração.'); }
    finally { setBusy(false); }
  }
  const inbox = inboxes.find(i => String(i.id) === selected);
  return <section className="flows-panel">
    <h2>Chatbot nas caixas de atendimento</h2>
    <p>Use um Flow em caixas WhatsApp, Instagram ou e-mail já cadastradas no JRC Conversas ou em uma instalação compatível com Chatwoot.</p>
    <button type="button" disabled={busy} onClick={() => { setOpen(true); void action(load); }}>Caixas do Chatwoot / JRC</button>
    {error && <p role="alert" className="flows-alert flows-alert--error">{error}</p>}
    {notice && <p role="status" className="flows-alert">{notice}</p>}
    {open && <>
      {account && <p>Conta vinculada: {account}. O vínculo usa exclusivamente as credenciais desta empresa.</p>}
      {inboxes.length ? <>
        <label>Caixa para o chatbot<select value={selected} disabled={busy} onChange={e => setSelected(e.target.value)}>
          {inboxes.map(i => <option key={i.id} value={i.id}>{i.name} · {i.channelType.replace('Channel::', '')}</option>)}
        </select></label>
        {inbox?.binding && <p>{statusLabel(inbox.binding.status)}{inbox.binding.lastError ? ' · ' + (labels[inbox.binding.lastError] ?? inbox.binding.lastError) : ''}</p>}
        {editable && <div className="flows-actions">
          <button type="button" className="flows-primary" disabled={busy || !published || !inbox || Boolean(inbox.binding && inbox.binding.flowId !== flowId)} onClick={() => void action(async () => {
            await client.request('/v1/flows/' + flowId + '/chatwoot/bind', { method: 'POST', body: JSON.stringify({ inboxId: Number(selected) }) });
            await load(); setNotice('Chatbot ativado. Novas conversas pendentes nesta caixa serão atendidas pelo Flow.');
          })}>Ativar chatbot nesta caixa</button>
          {inbox?.binding?.flowId === flowId && <button type="button" disabled={busy} onClick={() => void action(async () => {
            const result = await client.request<{ remoteDetached: boolean }>('/v1/flows/chatwoot/' + inbox.binding!.id + '/disable', { method: 'POST', body: '{}' });
            await load(); setNotice(result.remoteDetached ? 'Chatbot desativado nesta caixa.' : 'Flow desativado no Broker. Remova também o Agent Bot na configuração desta caixa no Chatwoot.');
          })}>Desativar chatbot da caixa</button>}
        </div>}
      </> : !busy && !error && <p>Nenhuma caixa disponível na conta vinculada.</p>}
      <p className="flows-help">O Broker cria e associa um Agent Bot à caixa. Mensagens de texto iniciam o atendimento enquanto a conversa está pendente; uma resposta humana ou a abertura da conversa interrompe o bot. Esta versão não interpreta anexos nem executa código do JSON.</p>
      <button type="button" disabled={busy} onClick={() => void action(async () => setRuns((await client.request<{ data: Run[] }>('/v1/flows/' + flowId + '/chatwoot/runs')).data))}>Ver execuções nas caixas</button>
      {runs && <div className="flows-runs">{runs.length ? runs.map(run => <details key={run.id}>
        <summary>{run.inboxName} · {statusLabel(run.status)} · {new Date(run.createdAt).toLocaleString('pt-BR')}</summary>
        <p>Conversa {run.conversationId}{run.errorCode ? ' · ' + run.errorCode : ''}</p>
        <ul>{run.deliveries?.map(d => <li key={d.id}>{statusLabel(d.status)}{d.errorCode ? ' · ' + d.errorCode : ''}</li>)}</ul>
      </details>) : <p>Ainda não há execuções nas caixas.</p>}</div>}
    </>}
  </section>;
}
