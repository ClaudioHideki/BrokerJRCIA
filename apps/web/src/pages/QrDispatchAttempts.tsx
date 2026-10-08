import {useEffect,useRef,useState} from 'react';
import {QrDispatchAttemptsResponseSchema,QrDispatchAttemptViewSchema,type QrDispatchAttemptView} from '@jrc/contracts';
import type {ApiClient} from '../api/client.js';

export function QrDispatchAttempts({client,conversationId,canAbandon,onChanged,refreshRevision=0}:{client:ApiClient;conversationId:string;canAbandon:boolean;onChanged:()=>void;refreshRevision?:number}) {
  const [data,setData]=useState<QrDispatchAttemptView[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [selected,setSelected]=useState<string|null>(null),[reason,setReason]=useState(''),[acknowledged,setAcknowledged]=useState(false),[busy,setBusy]=useState(false);
  const controllers=useRef(new Set<AbortController>()),readController=useRef<AbortController|null>(null),generation=useRef(0),lock=useRef(false);
  async function refresh(current=generation.current) {
    readController.current?.abort();
    const controller=new AbortController();readController.current=controller;controllers.current.add(controller);setLoading(true);
    try {
      const parsed=QrDispatchAttemptsResponseSchema.parse(await client.request<unknown>(`/v1/messaging/conversations/${encodeURIComponent(conversationId)}/qr-dispatch-attempts`,{signal:controller.signal}));
      if(current===generation.current&&!controller.signal.aborted){setData(parsed.data);setError('');}
    }catch{if(current===generation.current&&!controller.signal.aborted)setError('Não foi possível consultar as tentativas de envio. Atualize para tentar novamente.');}
    finally{controllers.current.delete(controller);if(readController.current===controller)readController.current=null;if(current===generation.current&&!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{
    generation.current++;setData([]);setSelected(null);setReason('');setAcknowledged(false);setBusy(false);lock.current=false;
    return()=>{generation.current++;for(const controller of controllers.current)controller.abort();controllers.current.clear();readController.current=null;};
  },[client,conversationId]);
  useEffect(()=>{void refresh();},[client,conversationId,refreshRevision]);
  async function abandon(a:QrDispatchAttemptView) {
    if(lock.current||!canAbandon||!acknowledged||reason.trim().length<5)return;
    lock.current=true;setBusy(true);const current=generation.current,controller=new AbortController();controllers.current.add(controller);
    try {
      QrDispatchAttemptViewSchema.parse(await client.request(`/v1/messaging/qr-dispatch-attempts/${encodeURIComponent(a.id)}/abandon`,{
        method:'POST',signal:controller.signal,body:JSON.stringify({expectedRevision:a.revision,reason:reason.trim()}),
      }));
      if(current===generation.current&&!controller.signal.aborted){setSelected(null);setReason('');setAcknowledged(false);onChanged();await refresh(current);}
    }catch{if(current===generation.current&&!controller.signal.aborted)setError('Não foi possível abandonar a tentativa. Atualize e confira seu resultado atual.');}
    finally{controllers.current.delete(controller);if(current===generation.current&&!controller.signal.aborted){lock.current=false;setBusy(false);}}
  }
  return <section aria-label="Tentativas de envio QR">
    {error?<p role="alert">{error}</p>:null}
    {data.map(a=><div key={a.id}>
      <p><a href={`#message-${a.messageId}`}>Tentativa de envio</a> · {a.state==='UNKNOWN'?'Resultado incerto':a.state==='DISPATCHED'?'Aguardando confirmação':'Abandonada sem confirmação de entrega'}</p>
      {a.state==='UNKNOWN'?<p>O resultado continua incerto, mesmo sem eco recebido. Esta tentativa impede novas saídas até abandono administrativo explícito.</p>:null}
      {canAbandon&&a.state==='UNKNOWN'?selected===a.id?<form onSubmit={event=>{event.preventDefault();void abandon(a);}}>
        <label>Motivo do abandono da tentativa<textarea required minLength={5} maxLength={500} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
        <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event=>setAcknowledged(event.target.checked)}/>Reconheço o resultado incerto e abandono esta tentativa sem reenviar nem confirmar entrega.</label>
        <button type="submit" disabled={busy||!acknowledged||reason.trim().length<5}>Confirmar abandono da tentativa</button>
        <button type="button" disabled={busy} onClick={()=>setSelected(null)}>Cancelar</button>
      </form>:<button type="button" disabled={busy} onClick={()=>{setSelected(a.id);setReason('');setAcknowledged(false);}}>Abandonar tentativa sem reenvio</button>:null}
    </div>)}
    <button type="button" disabled={loading||busy} onClick={()=>void refresh()}>Atualizar tentativas de envio</button>
  </section>;
}
