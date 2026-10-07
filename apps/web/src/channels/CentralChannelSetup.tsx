import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link} from 'react-router';
import {CentralCutoverOperationSchema,CentralInboxListSchema,CentralInboxPreviewSchema,CreateChannelResponseV1Schema} from '@jrc/contracts';
import type {z} from 'zod';
import type {ApiClient} from '../api/client.js';
type Operation=z.infer<typeof CentralCutoverOperationSchema>;
type Preview=z.infer<typeof CentralInboxPreviewSchema>;
type Props={organizationId:string;tenantRevision:number;client:ApiClient;operationId?:string|undefined;channelId?:string|undefined;onOperation?:(id:string)=>void};
const stages={DETACH:'Conferir e retirar o bot anterior',CREATE:'Preparar o bot do Broker',ATTACH:'Vincular o bot à caixa',VERIFY:'Conferir o vínculo na central'};
export function CentralChannelSetup({organizationId,tenantRevision,client,operationId,channelId,onOperation}:Props){
 const [inboxes,setInboxes]=useState<z.infer<typeof CentralInboxListSchema>['data']>([]),[inbox,setInbox]=useState(''),[name,setName]=useState('');
 const [preview,setPreview]=useState<Preview|null>(null),[replace,setReplace]=useState(false),[operation,setOperation]=useState<Operation|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),selection=useRef(0),pending=useRef(false),key=useRef<string>(crypto.randomUUID());
 const savedOperation=useRef<Operation|null>(null),storageKey=`central-cutover:${organizationId}:${tenantRevision}`;
 function remember(value:Operation){savedOperation.current=value;setOperation(value);if(['COMPLETE','ROLLED_BACK','CANCELED'].includes(value.status))sessionStorage.removeItem(storageKey);}
 useEffect(()=>{
  const epoch=++generation.current,abort=new AbortController();pending.current=false;setBusy(false);setError('');setOperation(null);setPreview(null);setInbox('');setName('');setReplace(false);setInboxes([]);key.current=crypto.randomUUID();
  savedOperation.current=null;const recoveryKey=sessionStorage.getItem(storageKey);if(recoveryKey)key.current=recoveryKey;
  const path=operationId?`/v1/channels/central/operations/${encodeURIComponent(operationId)}`:channelId?`/v1/channels/${encodeURIComponent(channelId)}/central-operation`:recoveryKey?`/v1/channels/central/operations/by-key/${encodeURIComponent(recoveryKey)}`:'/v1/channels/central/inboxes';
  void client.request(path,{signal:abort.signal}).then(value=>{if(generation.current!==epoch)return;if(operationId||channelId||recoveryKey)remember(CentralCutoverOperationSchema.parse(value));else setInboxes(CentralInboxListSchema.parse(value).data);}).catch(async failure=>{
   if(generation.current!==epoch)return;
   if(recoveryKey&&!operationId&&!channelId&&failure?.status===404){
    sessionStorage.removeItem(storageKey);key.current=crypto.randomUUID();
    try{const list=CentralInboxListSchema.parse(await client.request('/v1/channels/central/inboxes',{signal:abort.signal}));if(generation.current===epoch)setInboxes(list.data);return;}catch{/* Show the ordinary unavailable state. */}
   }
   if(generation.current===epoch)setError('Não foi possível conferir a configuração. Verifique a conta e a permissão na central.');
  });
  const unregister=client.registerTenantPurge(()=>{generation.current++;abort.abort();setOperation(null);setPreview(null);setInboxes([]);});
  return()=>{generation.current++;abort.abort();unregister();};
 },[organizationId,tenantRevision,client,operationId,channelId]);
 async function choose(value:string){
  const epoch=generation.current,version=++selection.current;setInbox(value);setPreview(null);setReplace(false);setError('');key.current=crypto.randomUUID();if(!value)return;
  try{const result=CentralInboxPreviewSchema.parse(await client.request(`/v1/channels/central/inboxes/${encodeURIComponent(value)}/preview`));if(epoch===generation.current&&version===selection.current)setPreview(result);}catch{if(epoch===generation.current&&version===selection.current)setError('Não foi possível conferir esta caixa. Atualize a seleção.');}
 }
 async function run(work:(epoch:number)=>Promise<void>){if(pending.current)return;pending.current=true;setBusy(true);setError('');const epoch=generation.current;
  try{await work(epoch);}catch{if(epoch===generation.current){setError('A operação não foi concluída. Confira o estado salvo antes de continuar; se a conta ou a caixa mudou, atualize a configuração.');
   const saved=savedOperation.current,path=saved?`/v1/channels/central/operations/${saved.id}`:`/v1/channels/central/operations/by-key/${key.current}`;
   try{const latest=CentralCutoverOperationSchema.parse(await client.request(path));if(epoch===generation.current)remember(latest);}catch{/* Preserve the reference for an explicit GET retry. */}
  }}finally{if(epoch===generation.current){pending.current=false;setBusy(false);}}
 }
 async function advance(saved:Operation,epoch:number){
  let current=saved;
  // Each response is authoritative; uncertainty stops automatic continuation.
  for(let i=0;i<4&&['PENDING','UNKNOWN','DISPATCHED'].includes(current.status);i++){
   current=CentralCutoverOperationSchema.parse(await client.request(`/v1/channels/central/operations/${current.id}/advance`,{method:'POST',body:JSON.stringify({expectedRevision:current.revision})}));
   if(epoch!==generation.current)return;remember(current);if(current.status!=='PENDING')break;
  }
 }
 async function prepare(event:FormEvent){event.preventDefault();if(!preview||!inbox)return;await run(async epoch=>{
  sessionStorage.setItem(storageKey,key.current);
  const result=CreateChannelResponseV1Schema.parse(await client.request('/v1/channels',{method:'POST',headers:{'Idempotency-Key':key.current},body:JSON.stringify({provider:'CENTRAL',name:name.trim(),inboxId:Number(inbox),...preview,replaceExistingBot:replace})}));
  if(epoch!==generation.current||result.provider!=='CENTRAL')return;remember(result.operation);onOperation?.(result.operation.id);await advance(result.operation,epoch);
 });}
 return <section className="panel" aria-label="Caixa conectada diretamente na central">
  <h2>Usar caixa existente na central</h2><p>O WhatsApp permanece conectado ao JRC Conversas ou Chatwoot. O Broker executa o Flow e confere o bot e os eventos desta caixa.</p>
  {error&&<p role="alert">{error}</p>}
  {error&&!operation&&<button disabled={busy} onClick={()=>void run(async epoch=>{const latest=CentralCutoverOperationSchema.parse(await client.request(`/v1/channels/central/operations/by-key/${key.current}`));if(epoch===generation.current){remember(latest);onOperation?.(latest.id);}})}>Recuperar configuração salva</button>}
  {!operation?<form className="form-grid" onSubmit={event=>void prepare(event)}>
   <label>Caixa existente na central<select value={inbox} disabled={busy} onChange={event=>void choose(event.target.value)}><option value="">Selecione</option>{inboxes.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
   <label>Nome no Broker<input value={name} disabled={busy} required maxLength={100} onChange={event=>{setName(event.target.value);key.current=crypto.randomUUID();}}/></label>
   {preview?.expectedBotId!=null&&<><p>Bot anterior observado: {preview.expectedBotId}. A substituição preserva o histórico das conversas.</p><label><input type="checkbox" checked={replace} disabled={busy} onChange={event=>setReplace(event.target.checked)}/>Autorizar a substituição do bot anterior desta caixa</label></>}
   <button className="button button--primary" disabled={busy||!name.trim()||!preview||(preview.expectedBotId!==null&&!replace)}>Preparar canal central</button>
  </form>:<>
   <p role="status">{operation.rollbackStep?`Reversão: ${operation.rollbackStep}`:stages[operation.step]} · {operation.status}</p>
   {operation.status==='COMPLETE'?<><p>Bot e vínculo conferidos na central. Envie uma nova mensagem de teste para comprovar o recebimento do evento antes de ativar o Flow.</p><Link to={`/channels/${operation.channelId}`}>Abrir canal e configurar Flow</Link></>:operation.status==='ROLLED_BACK'?<p>Reversão conferida na central. Histórico preservado. Se a credencial mudou, configure novamente o executor anterior antes de ativá-lo.</p>:operation.status==='CANCELED'?<p>Preparação cancelada sem alterações remotas. Vínculos locais anteriores permanecem pausados.</p>:<>
    {operation.status==='UNKNOWN'&&<p>O resultado remoto ainda não foi comprovado. A reconciliação consulta a central antes de avançar.</p>}
    <button className="button button--primary" disabled={busy} onClick={()=>void run(epoch=>advance(operation,epoch))}>{operation.status==='UNKNOWN'?'Reconciliar por consulta':'Continuar configuração'}</button>
   </>}
   {!['ROLLED_BACK','CANCELED'].includes(operation.status)&&<>
    <button disabled={busy} onClick={()=>void run(async epoch=>{const latest=CentralCutoverOperationSchema.parse(await client.request(`/v1/channels/central/operations/${operation.id}`));if(epoch===generation.current)remember(latest);})}>Atualizar estado salvo</button>
    {operation.revision===1&&operation.status==='PENDING'?<button disabled={busy} onClick={()=>void run(async epoch=>{const result=CentralCutoverOperationSchema.parse(await client.request(`/v1/channels/central/operations/${operation.id}/cancel`,{method:'POST',body:JSON.stringify({expectedRevision:operation.revision})}));if(epoch===generation.current){remember(result);sessionStorage.removeItem(storageKey);}})}>Cancelar preparação</button>:<button disabled={busy} onClick={()=>void run(async epoch=>{const result=CentralCutoverOperationSchema.parse(await client.request(`/v1/channels/central/operations/${operation.id}/rollback`,{method:'POST',body:JSON.stringify({expectedRevision:operation.revision})}));if(epoch===generation.current){remember(result);if(result.status==='ROLLED_BACK')sessionStorage.removeItem(storageKey);}})}>{operation.rollbackStep?'Revalidar reversão':'Reverter para o bot anterior'}</button>}
   </>}
  </>}
 </section>;
}
