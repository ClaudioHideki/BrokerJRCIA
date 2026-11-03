import type {ApiClient} from '../api/client.js';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link} from 'react-router';
import {AutomationExecutionPageSchema,type AutomationExecutionPage} from '@jrc/contracts';
import {useApiClient,useSession} from '../auth/SessionProvider.js';

const statuses:Record<string,string>={QUEUED:'Na fila',RUNNING:'Executando',WAITING:'Aguardando',HANDOFF:'Pausada para transferência',COMPLETED:'Concluída',FAILED:'Falhou',CANCELED:'Cancelada',UNKNOWN:'Requer reconciliação'};
const initialPeriod=()=>{const to=new Date();to.setUTCHours(0,0,0,0);to.setUTCDate(to.getUTCDate()+1);return{from:new Date(to.getTime()-7*86400000).toISOString().slice(0,10),to:to.toISOString().slice(0,10)};};
export function ExecutionExplorer({automationId}:{automationId:string|undefined}){
 const client=useApiClient(),{session}=useSession(),organizationId=session?.activeOrganization.id;
 return <ExecutionExplorerSurface client={client} organizationId={organizationId} automationId={automationId}/>;
}
export function ExecutionExplorerSurface({client,organizationId,automationId,endpoint,detailPath=(id:string)=>'/automation-executions/'+id,parsePage=AutomationExecutionPageSchema.parse}:{client:ApiClient;organizationId:string|undefined;automationId:string|undefined;endpoint?:string;detailPath?:(id:string)=>string;parsePage?:(value:unknown)=>AutomationExecutionPage}){
 const [period,setPeriod]=useState(initialPeriod),[status,setStatus]=useState(''),[search,setSearch]=useState(''),[channel,setChannel]=useState(''),[node,setNode]=useState('');
 const [page,setPage]=useState<AutomationExecutionPage|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),controller=useRef<AbortController|null>(null),applied=useRef<URLSearchParams|null>(null);
 const scope=organizationId+':'+(automationId??''),scopeRef=useRef(scope);scopeRef.current=scope;
 const [pageScope,setPageScope]=useState('');
 function query(){const params=new URLSearchParams({pageSize:'50',from:period.from+'T00:00:00.000Z',to:period.to+'T00:00:00.000Z'});
  if(automationId&&!endpoint)params.set('automationId',automationId);if(status)params.set('status',status);if(search.trim())params.set('search',search.trim());if(channel.trim())params.set('channelId',channel.trim());if(node.trim())params.set('nodeId',node.trim());return params;}
 async function load(params:URLSearchParams,append=false){
  if(!organizationId)return;const current=++generation.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;
  setBusy(true);setError('');if(!append){setPage(null);setPageScope(scope);applied.current=new URLSearchParams(params);}
  try{
   const data=parsePage(await client.request((endpoint??'/v1/executions')+'?'+params,{signal:abort.signal}));
   if(current!==generation.current||scopeRef.current!==scope)return;
   if(data.data.some(item=>item.organizationId!==organizationId||automationId&&item.automationId!==automationId))throw Error('Invalid execution scope');
   if(append&&data.nextCursor===params.get('cursor'))throw Error('Repeated page cursor');
   setPage(previous=>append&&previous?{...data,data:[...previous.data,...data.data.filter(item=>!previous.data.some(existing=>existing.id===item.id))]}:data);
  }catch{if(current===generation.current&&scopeRef.current===scope&&!abort.signal.aborted)setError('Não foi possível consultar as execuções. Revise o período (máximo 31 dias), os IDs e tente novamente.');}
  finally{if(current===generation.current&&scopeRef.current===scope)setBusy(false);}
 }
 useEffect(()=>{setPage(null);setPageScope(scope);setError('');applied.current=null;if(organizationId)void load(query());
  return()=>{generation.current++;controller.current?.abort();};},[client,scope]);
 function submit(event:FormEvent){event.preventDefault();void load(query());}
 const visible=pageScope===scope?page:null;
 return <section className="automation-page"><header className="automation-page-header"><div><h1>Execuções</h1><p>Histórico por versão, período e resultado. As métricas consideram todos os resultados dos filtros, incluindo páginas ainda não carregadas.</p></div></header>
  <form className="execution-filters" onSubmit={submit}>
   <label>De (UTC)<input type="date" required value={period.from} onChange={event=>setPeriod({...period,from:event.target.value})}/></label>
   <label>Até, sem incluir esta data (UTC)<input type="date" required value={period.to} onChange={event=>setPeriod({...period,to:event.target.value})}/></label>
   <label>Status<select value={status} onChange={event=>setStatus(event.target.value)}><option value="">Todos</option>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>ID da execução, conversa ou correlação<input value={search} onChange={event=>setSearch(event.target.value)}/></label>
   <label>ID do canal<input value={channel} onChange={event=>setChannel(event.target.value)}/></label>
   <label>ID da etapa<input value={node} maxLength={100} onChange={event=>setNode(event.target.value)}/></label><button disabled={busy||!organizationId}>Aplicar filtros</button>
  </form>
  {error&&<p role="alert">{error}</p>}
  {busy&&!visible&&<p role="status">Carregando execuções…</p>}
  {visible&&<><dl className="execution-metadata" aria-label="Métricas do período filtrado">
   {[['Total',visible.metrics.total],['Concluídas',visible.metrics.completed],['Em andamento',visible.metrics.active],['Falhas',visible.metrics.failed],['Resultado desconhecido',visible.metrics.unknown],['Pausadas para transferência',visible.metrics.handoff],['Canceladas',visible.metrics.canceled],['Taxa de conclusão',visible.metrics.completionRate===null?'—':visible.metrics.completionRate+'%']].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl><p>Conclusão do Flow não confirma entrega de mensagens ou ações externas. Consulte os efeitos no detalhe.</p>
   {visible.data.length?<div className="automation-execution-list">{visible.data.map(item=><Link key={item.id} to={detailPath(item.id)}>
    <span className={'execution-state execution-state--'+item.status.toLowerCase()}>{statuses[item.status]}</span><strong>v{item.version}</strong>
    <span>{new Date(item.startedAt).toLocaleString('pt-BR')} · {Math.round(item.durationMs/1000)} s</span><code>{item.id}</code>
    <span className="execution-row-context"><span>Canal: <code>{item.channelId}</code></span><span>Etapa registrada: <code>{item.currentNodeId??'—'}</code></span>{item.conversationRef&&<span>Conversa: <code>{item.conversationRef}</code></span>}</span>
   </Link>)}</div>:!busy&&!error&&<p className="flows-empty">Nenhuma execução encontrada.</p>}
   {visible.nextCursor&&<button disabled={busy} onClick={()=>{if(!applied.current||busy||!visible.nextCursor)return;const params=new URLSearchParams(applied.current);params.set('cursor',visible.nextCursor);void load(params,true);}}>{busy?'Carregando…':'Carregar mais execuções'}</button>}
  </>}
 </section>;
}
