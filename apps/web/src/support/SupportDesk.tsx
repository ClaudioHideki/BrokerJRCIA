import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SupportTicket, SupportTicketDetail, SupportTicketList, SupportStatus } from '@jrc/contracts';
import { ApiClientError } from '../api/client.js';
import './support.css';

export type SupportRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const statuses: Record<SupportStatus,string> = { OPEN:'Aguardando JRC', IN_PROGRESS:'Em atendimento', WAITING_CUSTOMER:'Aguardando sua resposta', RESOLVED:'Resolvido' };
const errorText = (error: unknown) => error instanceof ApiClientError && error.status===409
  ? 'O chamado foi atualizado. Atualize o histórico antes de responder novamente.'
  : error instanceof ApiClientError ? `${error.message}${error.requestId?` Referência: ${error.requestId}`:''}` : 'Não foi possível concluir. Tente novamente.';
export function SupportDesk({request,scopeKey,staff=false,canWrite}: {request: SupportRequest;scopeKey:string;staff?:boolean;canWrite:boolean}) {
  const api=useRef(request); api.current=request;
  const version=useRef(0),listVersion=useRef(0),selectionVersion=useRef(0),mutationVersion=useRef(0),mutationInFlight=useRef(false),selectedId=useRef<string|null>(null),pending=useRef<{body:string;requestId:string}|null>(null);
  const [tickets,setTickets]=useState<SupportTicket[]>([]), [cursor,setCursor]=useState<string|undefined>(), [detail,setDetail]=useState<SupportTicketDetail|null>(null);
  const [title,setTitle]=useState(''), [message,setMessage]=useState(''), [reply,setReply]=useState('');
  const [statusFilter,setStatusFilter]=useState(''),[companyFilter,setCompanyFilter]=useState(''),[assigneeFilter,setAssigneeFilter]=useState('');
  const [error,setError]=useState(''), [busy,setBusy]=useState(false), [loaded,setLoaded]=useState(false);
  const [updateNotice,setUpdateNotice]=useState('');
  const base=staff?'/support/tickets':'/v1/support/tickets';
  const filters=useRef({statusFilter,companyFilter,assigneeFilter});filters.current={statusFilter,companyFilter,assigneeFilter};
  async function refresh(next?:string) {
    const generation=version.current,listGeneration=++listVersion.current;
    const query=new URLSearchParams();if(next)query.set('cursor',next);
    const current=filters.current;
    if(staff){if(current.statusFilter)query.set('status',current.statusFilter);if(current.companyFilter.trim())query.set('company',current.companyFilter.trim());if(current.assigneeFilter)query.set('assignee',current.assigneeFilter);}
    const result=await api.current<SupportTicketList>(base+(query.size?`?${query}`:''));
    if(generation!==version.current||listGeneration!==listVersion.current)return;
    setTickets(current=>next?[...current,...result.data.filter(item=>!current.some(old=>old.id===item.id))]:result.data);setCursor(result.nextCursor);setLoaded(true);
  }
  useEffect(()=>{
    version.current++;listVersion.current++;selectionVersion.current++;mutationVersion.current++;mutationInFlight.current=false;selectedId.current=null;setTickets([]);setDetail(null);setTitle('');setMessage('');setReply('');setError('');setLoaded(false);setBusy(false);pending.current=null;
    const generation=version.current;
    void refresh().catch(reason=>{if(generation===version.current)setError(errorText(reason));});
    return()=>{version.current++;};
  },[scopeKey,staff]);
  useEffect(()=>{if(!staff)return;setCursor(undefined);setTickets([]);setLoaded(false);void refresh().catch(reason=>setError(errorText(reason)));},[statusFilter,companyFilter,assigneeFilter]);
  function requestId(body:unknown) {
    const encoded=JSON.stringify(body);
    if(pending.current?.body!==encoded)pending.current={body:encoded,requestId:crypto.randomUUID()};
    return pending.current.requestId;
  }
  async function select(id:string,before?:string) {
    const generation=version.current,selectionGeneration=++selectionVersion.current,startedDuringMutation=mutationInFlight.current;setBusy(true);setError('');
    const previousTicket=detail?.ticket;
    if(!before&&selectedId.current!==id){selectedId.current=id;setDetail(null);setReply('');pending.current=null;setUpdateNotice('');}
    try {
      const result=await api.current<SupportTicketDetail>(`${base}/${encodeURIComponent(id)}${before?`?before=${encodeURIComponent(before)}`:''}`);
      if(generation!==version.current||selectionGeneration!==selectionVersion.current||startedDuringMutation||mutationInFlight.current)return;
      if(!before&&previousTicket?.id===id&&previousTicket.revision!==result.ticket.revision)setUpdateNotice('O chamado recebeu uma atualização. Confira o histórico antes de enviar sua resposta.');
      setDetail(current=>before&&current?{...result,messages:[...result.messages.filter(item=>!current.messages.some(old=>old.id===item.id)),...current.messages]}:result);
    }catch(reason){if(generation===version.current&&selectionGeneration===selectionVersion.current&&!startedDuringMutation&&!mutationInFlight.current)setError(errorText(reason));}finally{if(generation===version.current&&selectionGeneration===selectionVersion.current&&!startedDuringMutation&&!mutationInFlight.current)setBusy(false);}
  }
  async function mutate(path:string,method:string,body:unknown) {
    const generation=version.current,mutationGeneration=++mutationVersion.current;mutationInFlight.current=true;selectionVersion.current++;setBusy(true);setError('');
    try {
      const result=await api.current<SupportTicketDetail>(path,method,body);
      if(generation!==version.current||mutationGeneration!==mutationVersion.current)return;
      selectedId.current=result.ticket.id;setDetail(result);setReply('');setTitle('');setMessage('');setUpdateNotice('');pending.current=null;await refresh();
    }catch(reason){if(generation===version.current&&mutationGeneration===mutationVersion.current)setError(errorText(reason));}finally{if(generation===version.current&&mutationGeneration===mutationVersion.current){mutationInFlight.current=false;setBusy(false);}}
  }
  const create=(event:FormEvent)=>{event.preventDefault();const body={title:title.trim(),message:message.trim()};void mutate(base,'POST',{...body,requestId:requestId(body)});};
  const respond=(event:FormEvent)=>{event.preventDefault();if(!detail)return;const body={message:reply.trim()};void mutate(`${base}/${detail.ticket.id}/replies`,'POST',{...body,revision:detail.ticket.revision,requestId:requestId([detail.ticket.id,body])});};
  const change=(status:SupportStatus,assignToMe?:boolean)=>{if(detail)void mutate(`${base}/${detail.ticket.id}`,'PATCH',{revision:detail.ticket.revision,status,...(assignToMe===undefined?{}:{assignToMe})});};
  useEffect(()=>{const id=detail?.ticket.id;if(!id)return;const reconnect=()=>{void select(id).then(()=>refresh().catch(reason=>setError(errorText(reason))));};window.addEventListener('online',reconnect);return()=>window.removeEventListener('online',reconnect);},[detail?.ticket.id,scopeKey,staff]);
  return <section className="support-desk" aria-busy={busy}>
    <header className="support-header"><div><h1>{staff?'Chamados recebidos':'Suporte JRC'}</h1><p>{staff?'Atenda as solicitações das empresas e acompanhe a primeira resposta.':'Abra uma solicitação e acompanhe o atendimento da equipe JRC por aqui.'}</p></div><button className="button button--secondary" disabled={busy} onClick={()=>{setError('');void refresh().catch(reason=>setError(errorText(reason)));}}>Atualizar chamados</button></header>
    {error&&<p role="alert" className="notice notice--error">{error}</p>}
    {updateNotice&&<p role="status" className="notice">{updateNotice}</p>}
    {staff&&<div className="support-actions"><label>Filtrar situação<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">Todas</option>{Object.entries(statuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Filtrar empresa<input value={companyFilter} onChange={e=>setCompanyFilter(e.target.value)} placeholder="Nome da empresa" /></label><label>Filtrar responsável<select value={assigneeFilter} onChange={e=>setAssigneeFilter(e.target.value)}><option value="">Todos</option><option value="unassigned">Sem responsável</option><option value="me">Meus chamados</option></select></label></div>}
    {!staff&&canWrite&&<form className="panel support-form" onSubmit={create}><h2>Novo chamado</h2><label>Assunto<input required minLength={5} maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Descreva o problema<textarea required maxLength={10000} value={message} onChange={e=>setMessage(e.target.value)}/></label><small>Informe o canal e o que aconteceu. Não envie senhas, tokens ou chaves privadas.</small><button className="button button--primary" disabled={busy}>Abrir chamado</button></form>}
    <div className="support-columns"><section className="panel support-list" aria-label="Lista de chamados">
      {!loaded&&!error&&<p role="status">Carregando chamados…</p>}{loaded&&!tickets.length&&<p>Nenhum chamado encontrado.</p>}
      {tickets.map(ticket=><button key={ticket.id} disabled={busy} className={`support-ticket ${detail?.ticket.id===ticket.id?'support-ticket--selected':''}`} onClick={()=>void select(ticket.id)}><strong>{ticket.title}</strong><span>{staff?`${ticket.organizationName} · `:''}{staff&&ticket.status==='WAITING_CUSTOMER'?'Aguardando cliente':statuses[ticket.status]}{ticket.firstResponseState==='OVERDUE'?' · Primeira resposta vencida':''}</span><small>Atualizado {new Date(ticket.updatedAt).toLocaleString('pt-BR')}</small></button>)}
      {cursor&&<button disabled={busy} onClick={()=>void refresh(cursor).catch(reason=>setError(errorText(reason)))}>Carregar mais chamados</button>}
    </section><section className="panel support-thread" aria-label="Histórico do chamado">
      {!detail&&<p>Selecione um chamado para acompanhar o atendimento.</p>}
      {detail&&<><div className="support-header"><div><h2>{detail.ticket.title}</h2><p>{staff&&detail.ticket.status==='WAITING_CUSTOMER'?'Aguardando cliente':statuses[detail.ticket.status]}{staff?` · ${detail.ticket.organizationName}`:''}</p></div><button disabled={busy} onClick={()=>void select(detail.ticket.id)}>Atualizar histórico</button></div>
        <p className="support-deadline">{detail.ticket.firstResponseState==='OVERDUE'?'Primeira resposta vencida · ':''}{detail.ticket.firstResponseAt?`Primeira resposta em ${new Date(detail.ticket.firstResponseAt).toLocaleString('pt-BR')}`:`Prazo de primeira resposta: ${new Date(detail.ticket.responseDueAt).toLocaleString('pt-BR')}`}</p>
        {staff&&canWrite&&<div className="support-actions"><button disabled={busy} onClick={()=>change('IN_PROGRESS',true)}>Assumir atendimento</button><label>Situação<select disabled={busy} value={detail.ticket.status} onChange={e=>change(e.target.value as SupportStatus)}>{Object.entries(statuses).map(([value,label])=><option key={value} value={value}>{value==='WAITING_CUSTOMER'?'Aguardando cliente':label}</option>)}</select></label></div>}
        {detail.olderMessagesAvailable&&<button disabled={busy} onClick={()=>void select(detail.ticket.id,detail.messages[0]?.id)}>Carregar mensagens anteriores</button>}
        <ol className="support-messages">{detail.messages.map(item=><li key={item.id} className={item.kind==='EVENT'?'support-event':''}><strong>{item.authorKind==='PLATFORM'?'Equipe JRC':'Empresa'}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('pt-BR')}</time><p>{item.body}</p></li>)}</ol>
        {canWrite&&<><form className="support-form" onSubmit={respond}><label>Resposta<textarea required maxLength={10000} value={reply} onChange={e=>setReply(e.target.value)}/></label><small>{detail.ticket.status==='RESOLVED'?'Enviar uma resposta reabre este chamado.':'A resposta fica disponível neste histórico.'}</small><button className="button button--primary" disabled={busy}>Enviar resposta</button></form>{detail.ticket.status!=='RESOLVED'&&<button className="button button--secondary" disabled={busy} onClick={()=>change('RESOLVED')}>Marcar como resolvido</button>}</>}
      </>}
    </section></div>
  </section>;
}
