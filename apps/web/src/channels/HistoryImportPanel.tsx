import {useEffect,useRef,useState,type FormEvent} from 'react';
import {HistoryImportSelectionSchema,type HistoryImportCapability,type HistoryImportOperation} from '@jrc/contracts';
import {z} from 'zod';
import type {ApiClient} from '../api/client.js';
import {historyImportApi} from './history-import-api.js';
type Props={client:ApiClient;organizationId:string;channelId:string};
const recoverySchema=z.object({requestId:z.string().uuid(),operationId:z.string().uuid().optional(),selection:HistoryImportSelectionSchema.optional()}).strict();
type Recovery=z.infer<typeof recoverySchema>;
const reasons={SOURCE_NOT_CONFIGURED:'A fonte de histórico não está configurada.',CHANNEL_UNAVAILABLE:'Esta caixa não está disponível para importar histórico.',IDENTITY_NOT_VERIFIED:'A identidade desta caixa ainda não foi verificada.',SOURCE_UNAVAILABLE:'A fonte de histórico está indisponível no momento.'};
function definitive(value:unknown){const error=value as {status?:number;code?:string};return error?.code==='HISTORY_SOURCE_NOT_CONFIGURED'||Boolean(error?.status&&error.status>=400&&error.status<500&&![408,429].includes(error.status));}
function failureMessage(value:unknown){const error=value as {status?:number;code?:string};if(error?.code==='HISTORY_SOURCE_NOT_CONFIGURED')return reasons.SOURCE_NOT_CONFIGURED;if(error?.code?.includes('BINDING')||error?.code?.includes('IDENTITY'))return 'O vínculo ou a identidade da caixa mudou. Confira a configuração antes de continuar.';if(error?.status===403)return 'Você não tem permissão para gerenciar esta importação.';if(error?.status===400)return 'Confira o intervalo UTC e o limite de mensagens.';return 'Não foi possível confirmar a operação. Consulte o estado salvo antes de continuar.';}
export function HistoryImportPanel({client,organizationId,channelId}:Props){
 const [capability,setCapability]=useState<HistoryImportCapability|null>(null),[operation,setOperation]=useState<HistoryImportOperation|null>(null),[recovery,setRecovery]=useState<Recovery|null>(null);
 const [from,setFrom]=useState(''),[to,setTo]=useState(''),[maxRecords,setMaxRecords]=useState(1000),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const activeRequest=useRef<string|null>(null);
 const generation=useRef(0),pending=useRef(false),controller=useRef<AbortController|null>(null),current=useRef<HistoryImportOperation|null>(null);
 const storageKey=`history-import:${organizationId}:${channelId}`;
 function saveRecovery(value:Recovery|null){setRecovery(value);try{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}catch{/* Recovery remains available in memory. */}}
 function remember(value:HistoryImportOperation){if(activeRequest.current!==value.requestId)return;if(current.current?.id===value.id&&current.current.revision>=value.revision)return;current.current=value;setOperation(value);saveRecovery(value.state==='OPEN'?{requestId:value.requestId,operationId:value.id}:null);}
 useEffect(()=>{
  const epoch=++generation.current,abort=new AbortController();controller.current=abort;pending.current=false;current.current=null;activeRequest.current=null;
  setCapability(null);setOperation(null);setRecovery(null);setBusy(false);setError('');setFrom('');setTo('');setMaxRecords(1000);
  const api=historyImportApi(client,organizationId,channelId,abort.signal);
  void api.capability().then(value=>{if(epoch===generation.current){setCapability(value);setMaxRecords(Math.min(1000,value.maxRecords));if(value.availableFrom)setFrom(new Date(Math.ceil(Date.parse(value.availableFrom)/60000)*60000).toISOString().slice(0,16));}}).catch(()=>{if(epoch===generation.current)setError('Não foi possível conferir a disponibilidade do histórico. Atualize a página para tentar novamente.');});
  let saved:Recovery|null=null;try{const raw=sessionStorage.getItem(storageKey);if(raw){const parsed=recoverySchema.safeParse(JSON.parse(raw));if(parsed.success)saved=parsed.data;else sessionStorage.removeItem(storageKey);}}catch{/* Ignore invalid local recovery data. */}
  if(saved){const value=saved;activeRequest.current=value.requestId;setRecovery(value);void (value.operationId?api.get(value.operationId,value.requestId):api.byRequest(value.requestId)).then(result=>{if(epoch===generation.current)remember(result);}).catch(failure=>{if(epoch===generation.current){setError('Não foi possível recuperar a importação. Consulte novamente antes de iniciar outra.');}});}
  const unregister=client.registerTenantPurge(()=>{generation.current++;abort.abort();activeRequest.current=null;current.current=null;setCapability(null);setOperation(null);setRecovery(null);setError('');});
  return()=>{generation.current++;abort.abort();unregister();};
 },[client,organizationId,channelId]);
 useEffect(()=>{
  if(!operation||operation.state!=='OPEN')return;
  const epoch=generation.current,abort=controller.current;if(!abort)return;
  let polling=false;
  const timer=setInterval(()=>{
   const value=current.current;if(polling||pending.current||abort.signal.aborted||!value||value.state!=='OPEN')return;
   polling=true;
   void historyImportApi(client,organizationId,channelId,abort.signal).get(value.id,value.requestId)
    .then(result=>{if(epoch===generation.current)remember(result);})
    .catch(failure=>{if(epoch===generation.current&&!abort.signal.aborted)setError(failureMessage(failure));})
    .finally(()=>{polling=false;});
  },5000);
  return()=>clearInterval(timer);
 },[client,organizationId,channelId,operation?.id,operation?.state]);
 async function run(work:(api:ReturnType<typeof historyImportApi>,epoch:number)=>Promise<void>){
  if(pending.current||!controller.current||controller.current.signal.aborted)return;pending.current=true;setBusy(true);setError('');const epoch=generation.current;
  try{await work(historyImportApi(client,organizationId,channelId,controller.current.signal),epoch);}catch(failure){if(epoch===generation.current)setError(failureMessage(failure));}finally{if(epoch===generation.current){pending.current=false;setBusy(false);}}
 }
 async function start(event:FormEvent){event.preventDefault();if(pending.current||!capability?.available||recovery||operation?.state==='OPEN')return;
  let selection;try{selection=HistoryImportSelectionSchema.parse({from:new Date(`${from}Z`).toISOString(),to:new Date(`${to}Z`).toISOString(),maxRecords});if(selection.from>selection.to||maxRecords>capability.maxRecords)throw new Error();}catch{setError('Informe um intervalo UTC válido e um limite dentro da capacidade disponível.');return;}
  if(capability.availableFrom&&Date.parse(selection.from)<Date.parse(capability.availableFrom)){setError('O início deve respeitar o período da identidade verificada. Registros anteriores podem pertencer a outro número.');return;}
  await run(async(api,epoch)=>{const requestId=crypto.randomUUID();activeRequest.current=requestId;saveRecovery({requestId,selection});let result;
   try{result=await api.start(selection,requestId);}catch(failure){if(epoch!==generation.current)return;if(definitive(failure)){saveRecovery(null);throw failure;}result=await api.byRequest(requestId);}
   if(epoch===generation.current)remember(result);
  });
 }
 function refresh(){void run(async(api,epoch)=>{const saved=current.current;let result;
  if(saved)result=await api.get(saved.id,saved.requestId);
  else if(recovery){try{result=recovery.operationId?await api.get(recovery.operationId,recovery.requestId):await api.byRequest(recovery.requestId);}catch(failure){if(epoch!==generation.current)return;if((failure as {status?:number})?.status!==404||!recovery.selection)throw failure;if(!capability?.available||recovery.selection.maxRecords>capability.maxRecords){setError(capability&&!capability.available&&capability.reason?reasons[capability.reason]:'A disponibilidade ou o limite da fonte precisa ser confirmado antes de retomar o início.');return;}result=await api.start(recovery.selection,recovery.requestId);}}
  if(result&&epoch===generation.current)remember(result);
 });}
 function mutate(action:'advance'|'cancel'){void run(async(api,epoch)=>{const saved=current.current;if(!saved||saved.state!=='OPEN')return;const result=await api[action](saved);if(epoch===generation.current)remember(result);});}
 return <section className="panel"><h2>Importar histórico</h2><p>Importa mensagens de texto de conversas individuais armazenadas na conexão, no intervalo selecionado. Esta importação não inclui grupos nem anexos e não recupera mensagens ausentes na origem. Cancelar não desfaz mensagens já importadas.</p>
 {error&&<p role="alert">{error}</p>}{!capability&&!error&&<p>Conferindo disponibilidade do histórico…</p>}
 {capability&&!capability.available&&<p>{capability.reason?reasons[capability.reason]:'A importação de histórico não está disponível.'}</p>}
 {capability?.availableFrom&&<p>Histórico verificável a partir de {capability.availableFrom} (UTC). O cache anterior não comprova a identidade do número atual.</p>}
 {operation&&<div aria-live="polite"><p>{operation.state==='COMPLETED'?'Importação concluída.':operation.state==='CANCELED'?'Importação cancelada. As mensagens já importadas foram preservadas.':operation.lastError?'Importação pausada após uma falha. Confira a conexão e a disponibilidade antes de continuar.':'Importação em andamento.'}</p>{operation.state==='COMPLETED'&&<p>As mensagens foram gravadas no Broker. Confira o espelhamento na fila de integração da central.</p>}{operation.state==='OPEN'&&!operation.lastError&&<p>O processamento continua em segundo plano.</p>}<p>Processados: {operation.processedRecords} de {operation.totalRecords}</p><p>Importadas: {operation.importedCount} · Duplicadas: {operation.duplicateCount}</p><p>Operação: {operation.id} · Revisão: {operation.revision}</p></div>}
 {(operation||recovery)&&<div className="button-row"><button type="button" disabled={busy} onClick={refresh}>Retomar importação</button>{operation?.state==='OPEN'&&<><button type="button" disabled={busy||!capability?.available} onClick={()=>mutate('advance')}>Processar próxima página</button><button type="button" disabled={busy} onClick={()=>mutate('cancel')}>Cancelar importação</button></>}</div>}
 {capability?.available&&!recovery&&operation?.state!=='OPEN'&&<form className="form-grid" onSubmit={event=>void start(event)}><label>Início (UTC)<input type="datetime-local" required value={from} onChange={event=>setFrom(event.target.value)}/></label><label>Fim (UTC)<input type="datetime-local" required value={to} onChange={event=>setTo(event.target.value)}/></label><label>Limite de mensagens<input type="number" required min={1} max={capability.maxRecords} value={maxRecords} onChange={event=>setMaxRecords(Number(event.target.value))}/></label><button disabled={busy||capability.maxRecords<1}>Iniciar importação</button></form>}
 </section>;
}
