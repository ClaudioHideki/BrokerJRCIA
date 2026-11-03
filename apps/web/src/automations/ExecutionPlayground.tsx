import {useEffect,useRef,useState} from 'react';
import {AUTOMATION_SIMULATION_MAX_EVENTS,AutomationExecutionPlaygroundSeedSchema,type AutomationExecutionPlaygroundSeed,type AiSimulationWait,type ConversationEffectWait} from '@jrc/contracts';
import {useApiClient,useSession} from '../auth/SessionProvider.js';
import {SimulationWaitControl,type SimulatedEvent} from './SimulationWaitControl.js';
import {HttpSimulationControl} from './HttpSimulationControl.js';
import {AiSimulationControl} from './AiSimulationControl.js';
import {ActionSimulationControl} from './ActionSimulationControl.js';
import {MediaSimulationControl} from './MediaSimulationControl.js';
type Result={source:{executionId:string;automationId:string;version:number};status:string;state:{variables:Record<string,unknown>;waiting?:{inputConfigVersion?:3}};effects:Array<{kind:string;payload:Record<string,unknown>}>;trace:unknown[];
 wait?:{kind:'EVENT'|'DELAY'|'IO';nodeId:string;waitId?:string;wakeAt?:string;deadlineAt?:string};httpWaitNodeId?:string;aiWait?:AiSimulationWait;actionWait?:ConversationEffectWait};
export function ExecutionPlayground({executionId,version}:{executionId:string;version:number}){
 const client=useApiClient(),{session}=useSession(),org=session?.activeOrganization.id,editable=Boolean(session&&['OWNER','ADMIN'].includes(session.activeOrganization.role));
 const [seed,setSeed]=useState<AutomationExecutionPlaygroundSeed|null>(null),[text,setText]=useState(''),[clock,setClock]=useState('');
 const [events,setEvents]=useState<SimulatedEvent[]>([]),[reply,setReply]=useState(''),[result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),scope=org+':'+executionId,scopeRef=useRef(scope),controller=useRef<AbortController|null>(null);scopeRef.current=scope;
 useEffect(()=>{const current=++generation.current,abort=new AbortController();controller.current=abort;setSeed(null);setResult(null);setError('');
  if(editable)void client.request(`/v1/executions/${executionId}/playground`,{signal:abort.signal}).then(value=>{
   const parsed=AutomationExecutionPlaygroundSeedSchema.parse(value);if(parsed.executionId!==executionId||parsed.version!==version)throw Error('REPLAY_SCOPE_MISMATCH');
   if(current===generation.current&&scopeRef.current===scope){setSeed(parsed);setText(parsed.text);setClock(parsed.clock);}
  }).catch(()=>{if(!abort.signal.aborted&&current===generation.current)setError('O contexto inicial desta execução não está disponível para replay.');});
  return()=>{generation.current++;abort.abort();};},[client,scope,version,editable]);
 function reset(){generation.current++;controller.current?.abort();setResult(null);setEvents([]);setBusy(false);setError('');}
 async function simulate(next:SimulatedEvent[]=[]){
  if(!seed||!editable||busy||next.length>AUTOMATION_SIMULATION_MAX_EVENTS)return;
  const current=++generation.current,abort=new AbortController();controller.current=abort;setBusy(true);setError('');
  try{const response=await client.request<Result>(`/v1/executions/${executionId}/simulate`,{method:'POST',signal:abort.signal,body:JSON.stringify({text,clock,events:next})});
   if(response.source.executionId!==executionId||response.source.automationId!==seed.automationId||response.source.version!==version)throw Error('REPLAY_SCOPE_MISMATCH');
   if(current===generation.current&&scopeRef.current===scope){setResult(response);setEvents(next);setReply('');}
  }catch{if(!abort.signal.aborted&&current===generation.current&&scopeRef.current===scope)setError('Não foi possível simular este cenário. Confira as condições de entrada, os dados e os limites do teste.');}
  finally{if(current===generation.current&&scopeRef.current===scope)setBusy(false);}
 }
 if(!editable)return null;
 const disabled=busy||events.length>=AUTOMATION_SIMULATION_MAX_EVENTS;
 return <section aria-label="Playground da versão histórica" className="automation-drawer">
  <h2>Playground · versão publicada {version}</h2><p>A mensagem inicial e a versão são preservadas. Nenhuma execução real será retomada, nem mensagem enviada ou rascunho alterado. Respostas seguintes e integrações são cenários fictícios.</p>
  {error&&<p role="alert">{error}</p>}{!seed&&!error&&<p>Carregando contexto inicial…</p>}
  {seed&&<><label>Mensagem inicial do replay<input maxLength={4096} value={text} onChange={event=>{reset();setText(event.target.value);}}/></label>
   <label>Horário do replay (UTC)<input type="datetime-local" step="1" value={clock.slice(0,19)} onChange={event=>{const date=new Date(event.target.value+'Z');if(Number.isFinite(date.getTime())){reset();setClock(date.toISOString());}}}/></label>
   <button disabled={busy} onClick={()=>void simulate()}>Simular versão histórica</button>
   {result&&<><p>{result.status==='COMPLETED'?'Simulação concluída':result.status==='WAITING'?'Simulação aguardando entrada':'Transferência simulada'} · {events.length}/{AUTOMATION_SIMULATION_MAX_EVENTS} eventos</p>
    {result.effects.map((effect,index)=><p key={index}>{effect.kind==='SEND_TEXT'?String(effect.payload.text??''):'Ação externa simulada: '+effect.kind}</p>)}
    {result.wait?.kind==='EVENT'&&<form onSubmit={event=>{event.preventDefault();if(!disabled&&reply.trim())void simulate([...events,{type:'MESSAGE',text:reply}]);}}><label>Resposta no replay<input disabled={disabled} maxLength={4096} value={reply} onChange={event=>setReply(event.target.value)}/></label><button disabled={disabled||!reply.trim()}>Responder no replay</button></form>}
    {result.wait?.kind==='EVENT'&&result.state.waiting?.inputConfigVersion===3&&<MediaSimulationControl disabled={disabled} onInput={event=>void simulate([...events,event])}/>}
    {(result.wait?.kind==='DELAY'||result.wait?.kind==='EVENT'&&result.wait.deadlineAt)&&<SimulationWaitControl wakeAt={result.wait.kind==='DELAY'?result.wait.wakeAt:result.wait.deadlineAt} clock={clock} events={events} disabled={disabled} onAdvance={seconds=>void simulate([...events,{type:'ELAPSE',seconds}])}/>}
    {result.wait?.kind==='IO'&&(result.actionWait?.waitId===result.wait.waitId&&result.actionWait?.nodeId===result.wait.nodeId?<ActionSimulationControl key={result.actionWait.waitId} wait={result.actionWait} disabled={disabled} onResponse={response=>void simulate([...events,response])}/>:result.aiWait?.nodeId===result.wait.nodeId?<AiSimulationControl key={events.length} wait={result.aiWait} disabled={disabled} onResponse={response=>void simulate([...events,response])}/>:result.httpWaitNodeId===result.wait.nodeId?<HttpSimulationControl key={events.length} nodeId={result.wait.nodeId} disabled={disabled} onResponse={response=>void simulate([...events,response])}/>:<p>Esta integração não possui resposta fictícia disponível. Nenhuma requisição externa foi feita.</p>)}
    <details><summary>Decisões e variáveis do replay</summary><pre>{JSON.stringify({trace:result.trace,variables:result.state.variables},null,2)}</pre></details>
   </>}
  </>}
 </section>;
}
