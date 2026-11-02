import {useEffect,useRef,useState} from 'react';
import {IntegrationDeliverySummarySchema} from '@jrc/contracts';
import type {z} from 'zod';
import type {IntegrationRequest} from './ChatwootPanel.js';
import {ApiClientError} from '../api/client.js';
import './delivery-diagnostics.css';

type Summary=z.infer<typeof IntegrationDeliverySummarySchema>;
type IssueCode=Summary['data'][number]['code'];
const guidance:Record<IssueCode,string>={
 CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION:'Confira a saudação, a atribuição automática e o executor da caixa. A configuração deve corresponder ao modo de atendimento escolhido.',
 GROUP_CENTRAL_SCOPE_CHANGED:'Confira se o grupo continua selecionado e se a conta, a caixa e o número ainda correspondem ao vínculo original. Não reaproveite uma entrega de outro vínculo.',
 CHATWOOT_INVALID_RESPONSE:'Confira a compatibilidade da versão da central e o formato da resposta antes de repetir a operação.',
 CHATWOOT_REQUEST_REJECTED:'Confira a conta, o token e as permissões da caixa na central.',
 MEDIA_DOWNLOAD_FAILED:'Confira a disponibilidade do anexo e o acesso ao armazenamento antes de tentar novamente.',
 MEDIA_TYPE_UNSUPPORTED:'O formato do anexo não é suportado neste caminho. Repetir a mesma entrega não altera o formato.',
 CHATWOOT_HISTORY_UNSUPPORTED:'Esta central não oferece importação de histórico neste caminho. As mensagens novas devem ser verificadas separadamente.',
 CHATWOOT_HISTORY_UNAVAILABLE:'Confira a disponibilidade da importação histórica na central. Preserve as tarefas pendentes e a mesma identificação da mensagem ao retomar; não envie o histórico como mensagens novas ao cliente.',
 CHATWOOT_OUTCOME_UNKNOWN:'Confira o resultado na central antes de reenviar. Um timeout não prova que a entrega falhou.',
 OTHER:'Consulte o diagnóstico da tarefa pelo seu identificador antes de decidir a próxima ação.',
};
const titles:Record<IssueCode,string>={
 CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION:'Configuração de atendimento necessária',
 GROUP_CENTRAL_SCOPE_CHANGED:'Vínculo da caixa ou do grupo alterado',
 CHATWOOT_INVALID_RESPONSE:'Resposta da central incompatível',
 CHATWOOT_REQUEST_REJECTED:'Solicitação recusada pela central',
 MEDIA_DOWNLOAD_FAILED:'Anexo indisponível para download',
 MEDIA_TYPE_UNSUPPORTED:'Formato de anexo não suportado',
 CHATWOOT_HISTORY_UNSUPPORTED:'Importação de histórico não suportada',
 CHATWOOT_HISTORY_UNAVAILABLE:'Importação de histórico indisponível na central',
 CHATWOOT_OUTCOME_UNKNOWN:'Resultado na central não confirmado',
 OTHER:'Diagnóstico individual necessário',
};
const dateFormat=new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'UTC'});
function DiagnosticTime({value}:{value:string}){
 return <time dateTime={value}>{dateFormat.format(new Date(value))} (UTC)</time>;
}
export function DeliveryDiagnostics({request}:{request:IntegrationRequest}){
 const [summary,setSummary]=useState<Summary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [queriedAt,setQueriedAt]=useState('');
 const generation=useRef(0),active=useRef(true),inFlight=useRef(false);
 useEffect(()=>{active.current=true;generation.current++;inFlight.current=false;setSummary(null);setError('');setBusy(false);
  return()=>{active.current=false;generation.current++;};},[request]);
 async function load(){
  if(inFlight.current)return;
  inFlight.current=true;const current=++generation.current;setBusy(true);setError('');setSummary(null);
  try{const value=IntegrationDeliverySummarySchema.parse(await request('/jobs/summary'));
   if(active.current&&current===generation.current){setSummary(value);setQueriedAt(new Date().toISOString());}
  }catch(reason){if(active.current&&current===generation.current)setError(
   (reason instanceof ApiClientError&&reason.status===403?'Seu acesso não permite consultar o diagnóstico das entregas.':'Não foi possível consultar o diagnóstico.')+
   (reason instanceof ApiClientError&&reason.requestId?` Solicitação: ${reason.requestId}`:''));}
  finally{if(active.current&&current===generation.current){inFlight.current=false;setBusy(false);}}
 }
 return <section className="delivery-diagnostics" aria-label="Diagnóstico das entregas">
  <button type="button" className="button button--secondary" aria-disabled={busy} aria-busy={busy} onClick={()=>void load()}>Diagnóstico de todas as entregas</button>
  <p>Falhas e resultados incertos registrados em toda a empresa, em todas as caixas e vínculos, inclusive os desativados. A consulta considera todo o histórico, sem limite de 100 tarefas.</p>
  <p>Não representa a saúde atual da conexão nem confirma entrega. Esta consulta não reenvia mensagens.</p>
  {busy&&<p role="status">Consultando entregas…</p>}
  {error&&<p className="notice notice--error" role="alert">{error}</p>}
  {summary&&<>
   <p className="delivery-diagnostics__source">Fonte: tarefas de integração com a central. Consulta concluída em <DiagnosticTime value={queriedAt}/>.</p>
   {summary.data.length===0?<p role="status">Nenhuma entrega com falha ou resultado incerto.</p>:<div className="delivery-diagnostics__records" role="region" aria-label="Resumo das entregas">
    {summary.data.map(item=><article className="delivery-diagnostics__record" key={`${item.status}:${item.code}`}
     aria-label={`${item.status==='UNKNOWN'?'Resultado incerto':'Falha'}: ${titles[item.code]}`}>
     <div className="delivery-diagnostics__record-heading">
      <span className={`delivery-diagnostics__status delivery-diagnostics__status--${item.status.toLowerCase()}`}>{item.status==='UNKNOWN'?'Resultado incerto':'Falha'}</span>
      <strong>{item.total.toLocaleString('pt-BR')} {item.total===1?'tarefa':'tarefas'}</strong>
     </div>
     <h3>{titles[item.code]}</h3>
     <p>{item.status==='UNKNOWN'?guidance.CHATWOOT_OUTCOME_UNKNOWN:guidance[item.code]}</p>
     <details><summary>Ver período e código</summary>
      <dl><div><dt>Primeira tarefa criada</dt><dd><DiagnosticTime value={item.firstSeenAt}/></dd></div>
       <div><dt>Última tarefa criada</dt><dd><DiagnosticTime value={item.lastSeenAt}/></dd></div>
       <div><dt>Código do diagnóstico</dt><dd><code>{item.code}</code></dd></div></dl>
      <p>As datas indicam a criação das tarefas; não são horários de falha ou de resolução.</p>
     </details>
    </article>)}
   </div>}
  </>}
 </section>;
}
