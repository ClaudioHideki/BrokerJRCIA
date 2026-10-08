import {useEffect,useRef,useState} from 'react';
import {QrOutboundObservationsResponseSchema,QrOutboundObservationViewSchema,type QrOutboundObservationView} from '@jrc/contracts';
import type {ApiClient} from '../api/client.js';

const reasons:Record<QrOutboundObservationView['reason'],string>={
  QR_ACK_PENDING:'Uma tentativa de envio do Broker ainda não tem confirmação. Esta saída aguarda correlação pelo identificador do provedor.',
  QR_PROVIDER_ID_CONFLICT:'O identificador recebido conflita com outra mensagem. A saída permanece sem autoria confirmada.',
  QR_ABANDONED_ATTEMPT_UNRESOLVED:'A autoria continua indefinida após abandono. A saída não foi reenviada nem atribuída a uma pessoa.',
  QR_OBSERVATION_ABANDONED:'A reconciliação foi abandonada por administrador. O resultado do envio continua incerto.',
  QR_LIFECYCLE_RECONCILE:'A saída anterior ficou sem materialização após iniciar a exclusão. Ela não bloqueia a drenagem e não será reenviada.',
};

export function QrOutboundObservations({client,conversationId,canAbandon,onChanged,refreshRevision=0}:{client:ApiClient;conversationId:string;canAbandon:boolean;onChanged:()=>void;refreshRevision?:number}) {
  const [data,setData]=useState<QrOutboundObservationView[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [selected,setSelected]=useState<string|null>(null),[reason,setReason]=useState(''),[acknowledged,setAcknowledged]=useState(false),[busy,setBusy]=useState(false);
  const controllers=useRef(new Set<AbortController>()),readController=useRef<AbortController|null>(null),generation=useRef(0),lock=useRef(false);
  async function refresh(current=generation.current) {
    readController.current?.abort();
    const controller=new AbortController();readController.current=controller;controllers.current.add(controller);setLoading(true);
    try {
      const parsed=QrOutboundObservationsResponseSchema.parse(await client.request<unknown>(`/v1/messaging/conversations/${encodeURIComponent(conversationId)}/qr-outbound-observations`,{signal:controller.signal}));
      if(current===generation.current&&!controller.signal.aborted){setData(parsed.data);setError('');}
    }catch{if(current===generation.current&&!controller.signal.aborted)setError('Não foi possível consultar as saídas em reconciliação. Atualize para tentar novamente.');}
    finally{controllers.current.delete(controller);if(readController.current===controller)readController.current=null;if(current===generation.current&&!controller.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{
    generation.current++;setData([]);setSelected(null);setReason('');setAcknowledged(false);setBusy(false);lock.current=false;
    return()=>{generation.current++;for(const controller of controllers.current)controller.abort();controllers.current.clear();readController.current=null;};
  },[client,conversationId]);
  useEffect(()=>{void refresh();},[client,conversationId,refreshRevision]);
  async function abandon(o:QrOutboundObservationView) {
    if(lock.current||!canAbandon||!acknowledged||reason.trim().length<5)return;
    lock.current=true;setBusy(true);const current=generation.current,controller=new AbortController();controllers.current.add(controller);
    try {
      QrOutboundObservationViewSchema.parse(await client.request(`/v1/messaging/qr-outbound-observations/${encodeURIComponent(o.id)}/abandon`,{
        method:'POST',signal:controller.signal,body:JSON.stringify({expectedRevision:o.revision,attemptIds:o.attempts.filter(a=>a.state==='UNKNOWN').map(a=>a.id),reason:reason.trim()}),
      }));
      if(current===generation.current&&!controller.signal.aborted){setSelected(null);setAcknowledged(false);setReason('');onChanged();await refresh(current);}
    }catch{if(current===generation.current&&!controller.signal.aborted)setError('Não foi possível abandonar esta pendência. Atualize e confira as tentativas atuais.');}
    finally{controllers.current.delete(controller);if(current===generation.current&&!controller.signal.aborted){lock.current=false;setBusy(false);}}
  }
  return <section aria-label="Saídas observadas em reconciliação">
    {error?<p role="alert">{error}</p>:null}
    {data.map(o=><div key={o.id}>
      <p>{reasons[o.reason]}</p>
      {o.blocking?<p>Novas ações nesta conversa aguardam a reconciliação.</p>:null}
      {o.attempts.filter(a=>a.state!=='ABANDONED').map((a,index)=><p key={a.id}><a href={`#message-${a.messageId}`}>Tentativa {index+1}</a> · {a.state==='UNKNOWN'?'Resultado incerto':'Aguardando confirmação'}</p>)}
      {canAbandon&&o.disposition==='RECONCILE'?selected===o.id?<form onSubmit={event=>{event.preventDefault();void abandon(o);}}>
        <label>Motivo do abandono<textarea required minLength={5} maxLength={500} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
        <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event=>setAcknowledged(event.target.checked)}/>Reconheço as tentativas incertas e abandono a reconciliação sem reenviar nem confirmar entrega.</label>
        <button type="submit" disabled={busy||!acknowledged||reason.trim().length<5||o.attempts.some(a=>a.state==='DISPATCHED')}>Confirmar abandono sem reenvio</button>
        <button type="button" disabled={busy} onClick={()=>setSelected(null)}>Cancelar</button>
      </form>:<button type="button" disabled={busy||o.attempts.some(a=>a.state==='DISPATCHED')} onClick={()=>{setSelected(o.id);setReason('');setAcknowledged(false);}}>Abandonar reconciliação sem reenvio</button>:null}
    </div>)}
    <button type="button" disabled={loading||busy} onClick={()=>void refresh()}>Atualizar reconciliação</button>
  </section>;
}
