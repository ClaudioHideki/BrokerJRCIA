import { useEffect,useRef,useState } from 'react';
import { HistorySyncProgressSchema,type HistorySyncProgress } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';

type Props={client:ApiClient;organizationId:string;channelId:string};
const captureLabels={WAITING_IDENTITY:'Aguardando confirmação do número',CAPTURING:'Capturando histórico disponível',
  COMPLETE:'Captura confirmada',PARTIAL:'Captura parcial',BLOCKED:'Captura bloqueada'};
const workLabels={PENDING:'Aguardando processamento',RUNNING:'Em processamento',COMPLETE:'Confirmado',BLOCKED:'Bloqueado',NOT_CONFIGURED:'Central não configurada'};
/** Observation only: closing this panel never stops a worker. No replay, sends,
 * pairing, admission, or mutation is initiated by polling or refresh. */
export function HistorySyncPanel({client,organizationId,channelId}:Props) {
  const [value,setValue]=useState<HistorySyncProgress|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),refresh=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const epoch=++generation.current,controller=new AbortController();let pending=false;
    setValue(null);setError('');setBusy(false);
    const load=async()=>{
      if(pending||controller.signal.aborted)return;pending=true;setBusy(true);
      try {
        const data=HistorySyncProgressSchema.parse(await client.request(`/v1/channels/${encodeURIComponent(channelId)}/history-sync/v2/progress`,{signal:controller.signal}));
        if(data.organizationId!==organizationId||data.channelId!==channelId)throw Error('HISTORY_PROGRESS_SCOPE');
        if(generation.current===epoch){setValue(data);setError('');}
      } catch {
        if(generation.current===epoch){setValue(null);setError('Não foi possível confirmar o progresso desta caixa. Confira a conexão e suas permissões.');}
      } finally {pending=false;if(generation.current===epoch)setBusy(false);}
    };
    refresh.current=()=>{void load();};void load();
    const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void load();},5000);
    const unregister=client.registerTenantPurge(()=>{generation.current++;controller.abort();clearInterval(timer);refresh.current=()=>{};setValue(null);setError('');setBusy(false);});
    return()=>{generation.current++;controller.abort();clearInterval(timer);unregister();refresh.current=()=>{};};
  },[client,organizationId,channelId]);
  const run=value?.run;
  return <section className="panel" aria-label="Sincronização do histórico WhatsApp">
    <div className="button-row"><h3>Histórico e arquivos do WhatsApp</h3>
      <button type="button" disabled={busy} onClick={()=>refresh.current()}>Atualizar progresso</button></div>
    {error&&<p role="alert">{error}</p>}
    {!value&&!error&&<p role="status">{busy?'Consultando progresso…':'Progresso não consultado.'}</p>}
    {value&&!run&&<p>Nenhuma sincronização admitida para esta caixa.</p>}
    {run&&<div aria-live="polite">
      <p><strong>{run.state==='PAUSED'?'Sincronização pausada':run.state==='CANCELED'?'Sincronização cancelada':captureLabels[run.capture]}</strong></p>
      {!run.sourceTotalKnown&&<p>Total do WhatsApp ainda não confirmado. Os números abaixo representam os lotes já processados; não são uma porcentagem do celular.</p>}
      <dl className="form-grid">
        <div><dt>Captura</dt><dd>{run.counts.chats} conversas em lotes processados</dd><dd>{run.counts.capturedMessages} mensagens em lotes processados</dd></div>
        <div><dt>Persistência no Broker</dt><dd>{workLabels[run.persistence]}</dd><dd>{run.counts.persistedMessages} mensagens gravadas · {run.counts.duplicateMessages} já existentes</dd></div>
        <div><dt>Confirmação na central</dt><dd>{workLabels[run.projection]}</dd><dd>{run.counts.projectedMessages} de {run.counts.persistedMessages} mensagens confirmadas na central</dd></div>
        <div><dt>Arquivos</dt><dd>{run.counts.pendingMedia} arquivos pendentes</dd><dd>{run.counts.verifiedMedia} verificados · {run.counts.unavailableMedia} indisponíveis</dd></div>
      </dl>
      {(run.lastError||run.counts.blockedRecords>0||run.counts.unavailableMedia>0)&&<p role="status">Há pendências para conferir. Os registros retidos serão preservados.</p>}
      <p>Um arquivo verificado no Broker ainda precisa da confirmação de persistência na central. A sincronização não depende desta tela aberta.</p>
    </div>}
  </section>;
}
