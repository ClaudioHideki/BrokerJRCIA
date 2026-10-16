import {useEffect,useRef,useState} from 'react';
import {IntegrationDeliverySummarySchema} from '@jrc/contracts';
import type {z} from 'zod';
import type {IntegrationRequest} from './ChatwootPanel.js';

type Summary=z.infer<typeof IntegrationDeliverySummarySchema>;
const guidance:Record<string,string>={
 CHATWOOT_ATTENDANCE_POLICY_REQUIRES_CONFIGURATION:'Confira a saudação, a atribuição automática e o executor da caixa. A configuração deve corresponder ao modo de atendimento escolhido.',
 GROUP_CENTRAL_SCOPE_CHANGED:'Confira se o grupo continua selecionado e se a conta, a caixa e o número ainda correspondem ao vínculo original. Não reaproveite uma entrega de outro vínculo.',
 CHATWOOT_INVALID_RESPONSE:'Confira a compatibilidade da versão da central e o formato da resposta antes de repetir a operação.',
 CHATWOOT_REQUEST_REJECTED:'Confira a conta, o token e as permissões da caixa na central.',
 MEDIA_DOWNLOAD_FAILED:'Confira a disponibilidade do anexo e o acesso ao armazenamento antes de tentar novamente.',
 MEDIA_TYPE_UNSUPPORTED:'O formato do anexo não é suportado neste caminho. Repetir a mesma entrega não altera o formato.',
 OTHER:'Consulte o diagnóstico da tarefa pelo seu identificador antes de decidir a próxima ação.',
};
export function DeliveryDiagnostics({request}:{request:IntegrationRequest}){
 const [summary,setSummary]=useState<Summary|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),active=useRef(true),inFlight=useRef(false);
 useEffect(()=>{active.current=true;generation.current++;inFlight.current=false;setSummary(null);setError('');setBusy(false);
  return()=>{active.current=false;generation.current++;};},[request]);
 async function load(){
  if(inFlight.current)return;
  inFlight.current=true;const current=++generation.current;setBusy(true);setError('');setSummary(null);
  try{const value=IntegrationDeliverySummarySchema.parse(await request('/jobs/summary'));
   if(active.current&&current===generation.current)setSummary(value);
  }catch{if(active.current&&current===generation.current)setError('Não foi possível consultar o diagnóstico.');}
  finally{if(active.current&&current===generation.current){inFlight.current=false;setBusy(false);}}
 }
 return <section aria-label="Diagnóstico das entregas">
  <button type="button" className="button button--secondary" disabled={busy} onClick={()=>void load()}>Diagnóstico de todas as entregas</button>
  <p>Totais de falhas e resultados incertos de todo o histórico desta empresa, além das últimas 100 tarefas. Esta consulta não reenvia mensagens.</p>
  {busy&&<p role="status">Consultando entregas…</p>}
  {error&&<p role="alert">{error}</p>}
  {summary&&(summary.data.length===0?<p>Nenhuma entrega com falha ou resultado incerto.</p>:<table>
   <thead><tr><th>Situação</th><th>Diagnóstico</th><th>Total</th><th>Próxima ação</th></tr></thead>
   <tbody>{summary.data.map(item=><tr key={`${item.status}:${item.code}`}>
    <td>{item.status==='UNKNOWN'?'Resultado incerto':'Falha'}</td><td><code>{item.code}</code></td><td>{item.total}</td>
    <td>{item.status==='UNKNOWN'||item.code==='CHATWOOT_OUTCOME_UNKNOWN'?'Confira o resultado na central antes de reenviar. Um timeout não prova que a entrega falhou.':guidance[item.code]}</td>
   </tr>)}</tbody>
  </table>)}
 </section>;
}
