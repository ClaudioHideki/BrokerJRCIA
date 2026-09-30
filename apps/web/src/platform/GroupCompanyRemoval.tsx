import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiClientError } from '../api/client.js';
import { DeletionRequestedSchema, GroupCompanyRemovalListSchema, GroupCompanyRemovalPreviewSchema, GroupCompanyRemovalSchema,
  type GroupCompanyRemoval as Operation, type RequestGroupCompanyRemoval } from '@jrc/contracts';
type Preview=z.infer<typeof GroupCompanyRemovalPreviewSchema>;
type Request=(path:string,method?:string,body?:unknown)=>Promise<unknown>;
type Props={groupId:string;groupName:string;request:Request;disabled:boolean};
const stateLabels:Record<string,string>={RUNNING:'Exclusões em andamento',PARTIAL:'Exclusão parcialmente concluída',ACTION_REQUIRED:'Intervenção necessária',COMPLETED:'Exclusão concluída',
 REQUESTED:'Aguardando processamento',BLOCKING:'Aguardando pendências',CLEANING_EXTERNAL:'Conferindo remoção externa',REMOVING_DATA:'Removendo dados locais'};
const blockers:Record<string,string>={FLOW_REMOTE_BOT_ATTACHED:'Um proprietário ou administrador desta empresa deve abrir JRC Flows → selecionar o Flow → Conexões e desativar o vínculo da caixa. Confirme a remoção do robô em JRC Conversas/Chatwoot → Configurações → Caixas de entrada → Configuração do Bot. Depois consulte o impacto novamente.',
 PENDING_OR_UNCERTAIN_WORK:'Há envios ou operações com resultado pendente. Abra a empresa e confira as entregas antes de excluir.'};
export function GroupCompanyRemoval(props:Props){return <GroupCompanyRemovalOperation key={props.groupId} {...props}/>;}
export function GroupCompanyRemovalLookup({request,disabled}:{request:Request;disabled:boolean}){
 const [code,setCode]=useState(''),[operation,setOperation]=useState<Operation|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const live=useRef(true),generation=useRef(0),pending=useRef(false);
 useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;};},[]);
 async function lookup(){
  if(disabled||pending.current||!z.uuid().safeParse(code.trim()).success)return;
  const requested=code.trim(),version=++generation.current;pending.current=true;setBusy(true);setError('');setOperation(null);
  try{const value=GroupCompanyRemovalSchema.parse(await request(`/group-company-removals/${requested}`));
   if(value.operationId!==requested)throw new Error('OPERATION_MISMATCH');
   if(live.current&&version===generation.current)setOperation(value);
  }catch{if(live.current&&version===generation.current)setError('Não foi possível consultar esta operação. Confira o código e sua permissão de administrador global.');}
  finally{pending.current=false;if(live.current&&version===generation.current)setBusy(false);}
 }
 return <section className="panel" aria-label="Consulta de exclusões anteriores">
  <h3>Consultar uma exclusão anterior</h3><p>Guarde o código exibido ao solicitar a exclusão. Ele permite consultar o andamento mesmo depois que o grupo for removido.</p>
  <form onSubmit={event=>{event.preventDefault();void lookup();}}>
   <label>Código da operação de exclusão<input value={code} disabled={disabled||busy} onChange={event=>{setCode(event.target.value);setOperation(null);}}/></label>
   <button className="button button--secondary" disabled={disabled||busy||!z.uuid().safeParse(code.trim()).success}>Consultar operação de exclusão</button>
  </form>
  {error&&<p role="alert">{error}</p>}
  {operation&&<div><h4>{stateLabels[operation.status]}</h4><p>Operação: {operation.operationId}</p>
   {operation.groupStage==='REMOVED'&&<p>O grupo vazio também foi removido.</p>}
   {operation.groupStage==='ALREADY_REMOVED'&&<p>O grupo já foi removido.</p>}
   {operation.groupStage==='PRESERVED'&&<p>O grupo foi preservado. Consulte os vínculos atuais antes de solicitar sua remoção.</p>}
   <ul>{operation.companies.map(company=><li key={company.id}>{company.name??`Empresa removida (${company.id})`}: {stateLabels[company.status]??company.status}
    {company.status==='ACTION_REQUIRED'&&<p>Abra a empresa em Empresas → Plano e limites → Exclusão definitiva para conferir a pendência. A consulta do resultado externo não repete a exclusão.</p>}
   </li>)}</ul>
  </div>}
 </section>;
}
function GroupCompanyRemovalOperation({groupId,groupName,request,disabled}:Props){
 const api=useRef(request);api.current=request;
 const live=useRef(true),generation=useRef(0),pending=useRef(false);
 const [preview,setPreview]=useState<Preview|null>(null),[selected,setSelected]=useState<string[]>([]),[names,setNames]=useState<Record<string,string>>({});
 const [reason,setReason]=useState(''),[removeGroup,setRemoveGroup]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [operations,setOperations]=useState<Operation[]>([]),[uncertain,setUncertain]=useState<RequestGroupCompanyRemoval|null>(null);
 async function refresh(){
  if(pending.current)return;
  const current=++generation.current;
  try{
   const loaded:Operation[]=[];let cursor:string|null=null;const seen=new Set<string>();
   do{const page=GroupCompanyRemovalListSchema.parse(await api.current(`/groups/${groupId}/company-removals${cursor?`?cursor=${cursor}`:''}`));
    if(!live.current||current!==generation.current)return;
    if(page.data.some(item=>item.groupId!==groupId))throw new Error('GROUP_MISMATCH');
    loaded.push(...page.data);cursor=page.nextCursor;
    if(cursor){if(seen.has(cursor))throw new Error('CURSOR_REPEATED');seen.add(cursor);}
   }while(cursor);
   setOperations(loaded);
  }catch{if(live.current&&current===generation.current)setError('Não foi possível consultar as operações. Atualize o andamento; uma solicitação já recebida continua no servidor.');}
 }
 useEffect(()=>{live.current=true;void refresh();return()=>{live.current=false;generation.current++;};},[]);
 const active=operations.some(item=>['RUNNING','PARTIAL'].includes(item.status));
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>void refresh(),3000);return()=>clearInterval(timer);},[active]);
 async function mutate<T>(work:()=>Promise<T>,apply:(result:T)=>void){
  if(pending.current||disabled)return;pending.current=true;generation.current++;setBusy(true);setError('');
  try{const result=await work();if(live.current)apply(result);}catch(error){
   if(live.current){
    if(error instanceof ApiClientError&&['GROUP_REMOVAL_PREVIEW_CHANGED','GROUP_REMOVAL_CONFIRMATION_REQUIRED','GROUP_REMOVAL_COMPANY_BLOCKED',
      'GROUP_REMOVAL_COMPANY_ALREADY_REQUESTED','GROUP_REMOVAL_INVALID_REQUEST'].includes(error.code??'')){
      setUncertain(null);setPreview(null);setSelected([]);setNames({});
    }
    setError('A operação não foi confirmada. Confira o andamento antes de repetir. Uma prévia alterada ou vencida exige nova consulta.');
   }
  }finally{pending.current=false;if(live.current)setBusy(false);}
 }
 async function inspect(){
  if(reason.trim().length<5||uncertain)return;
  await mutate(async()=>GroupCompanyRemovalPreviewSchema.parse(await api.current(`/groups/${groupId}/company-removal-preview`,'POST',{reason:reason.trim()})),value=>{
   if(value.groupId!==groupId){setError('A prévia retornou outro grupo. Consulte novamente.');return;}
   setPreview(value);setSelected([]);setNames({});setRemoveGroup(false);
  });
 }
 async function submit(){
  if(!preview||selected.length===0||selected.length>200||!validNames||reason.trim().length<5)return;
  const value=uncertain??{groupId,expectedRevision:preview.groupRevision,previewId:preview.previewId,previewRevision:preview.previewRevision,
   selectedCompanyIds:selected,confirmation:{companies:selected.map(id=>({id,typedName:names[id]!})),removeGroupIfEmpty:removeGroup},reason:reason.trim(),idempotencyKey:crypto.randomUUID()};
  setUncertain(value);
  await mutate(async()=>GroupCompanyRemovalSchema.parse(await api.current(`/groups/${groupId}/company-removals`,'POST',value)),result=>{
   if(result.groupId!==groupId){setError('Não foi possível validar a operação. Atualize o andamento.');return;}
   setOperations(items=>[result,...items.filter(item=>item.operationId!==result.operationId)]);setPreview(null);setUncertain(null);setSelected([]);setNames({});
  });
 }
 async function reconcile(operation:Operation,company:Operation['companies'][number]){
  if(reason.trim().length<5)return;
  await mutate(async()=>DeletionRequestedSchema.parse(await api.current(`/organizations/${company.id}/deletion/${company.operationId}/reconcile`,'POST',{reason:reason.trim()})),result=>{
   setOperations(items=>items.map(item=>item.operationId===operation.operationId?{...item,status:'RUNNING',companies:item.companies.map(c=>c.id===company.id?{...c,...result,errorCode:null}:c)}:item));
  });
 }
 const validNames=selected.every(id=>names[id]===preview?.companies.find(company=>company.resourceId===id)?.resourceName);
 const locked=busy||disabled||uncertain!==null;
 return <section className="panel" aria-label="Exclusão de empresas selecionadas">
  <h3>Excluir empresas de {groupName}</h3>
  <p>Escolha somente as empresas que serão encerradas no Broker. Contas, caixas, conversas externas e ativos Meta são preservados. Usuários com acesso a outra empresa permanecem.</p>
  <label>Motivo da exclusão selecionada<textarea value={reason} minLength={5} maxLength={500} disabled={locked} onChange={event=>setReason(event.target.value)}/></label>
  <button className="button button--secondary" disabled={locked||reason.trim().length<5} onClick={()=>void inspect()}>Consultar impacto das empresas</button>
  <button className="button button--secondary" disabled={busy||disabled} onClick={()=>void refresh()}>Atualizar andamento das exclusões</button>
  {error&&<p role="alert">{error}</p>}
  {preview&&<div>
   <p>A prévia vale até {new Date(preview.expiresAt).toLocaleString('pt-BR')}. Nenhuma empresa vem selecionada.</p>
   {preview.companies.length===0&&<p>O grupo está vazio. Use Remover grupo para excluir somente o agrupamento.</p>}
   {preview.companies.map(company=><div key={company.resourceId} className="panel">
    <label><input type="checkbox" aria-label={`Selecionar ${company.resourceName}`} checked={selected.includes(company.resourceId)}
      disabled={locked||!company.canDelete||company.operationId!==null} onChange={event=>setSelected(items=>event.target.checked?[...items,company.resourceId]:items.filter(id=>id!==company.resourceId))}/>{company.resourceName}</label>
    <p>{company.counts.users??0} acessos; {company.counts.qrConnections??0} conexões QR; {company.counts.metaConnections??0} conexões Meta.</p>
    <ul>{company.externalEffects.map(effect=><li key={effect}>{effect}</li>)}</ul>
    {company.blockers.map(code=><p key={code}>{blockers[code]??'Uma pendência impede esta exclusão. Abra a empresa para conferir.'}</p>)}
    {company.operationId&&<p>Esta empresa já possui uma exclusão. Acompanhe sua operação existente.</p>}
    {selected.includes(company.resourceId)&&<label>Digite {company.resourceName}<input autoComplete="off" maxLength={120} value={names[company.resourceId]??''} disabled={locked}
      onChange={event=>setNames(values=>({...values,[company.resourceId]:event.target.value}))}/></label>}
   </div>)}
   <label><input type="checkbox" checked={removeGroup} disabled={locked} onChange={event=>setRemoveGroup(event.target.checked)}/>Remover também o grupo, somente se ficar vazio</label>
   <p>Empresas não selecionadas ou adicionadas depois permanecem. Se o grupo ainda tiver empresas, sua remoção será interrompida.</p>
   <button className="button button--danger" disabled={busy||disabled||!selected.length||selected.length>200||!validNames||reason.trim().length<5} onClick={()=>void submit()}>
    {uncertain?'Verificar solicitação enviada':'Excluir empresas selecionadas'}</button>
   {uncertain&&<p>Os dados desta solicitação estão preservados para consultar ou repetir a mesma operação, sem criar novas exclusões.</p>}
  </div>}
  {operations.map(operation=><section className="panel" key={operation.operationId} aria-label={`Operação ${operation.operationId}`}>
   <h4>{stateLabels[operation.status]}</h4><p>Operação: {operation.operationId}</p>
   {operation.groupStage==='REMOVED'&&<p>O grupo vazio também foi removido.</p>}
   {operation.groupStage==='NOT_REQUESTED'&&<p>A remoção do grupo não foi solicitada.</p>}
   {operation.errorCode==='GROUP_HAS_REMAINING_COMPANIES'&&<p>O grupo foi preservado porque ainda contém empresas. Revise os vínculos em Grupos econômicos; nenhuma empresa adicional foi excluída.</p>}
   {operation.errorCode==='LIFECYCLE_ACTOR_REVOKED'&&<p>A permissão do solicitante foi revogada. Um administrador global pode revisar e remover o grupo vazio pelo procedimento de remoção do grupo.</p>}
   <ul>{operation.companies.map(company=><li key={company.id}>
    <strong>{company.name??`Empresa removida (${company.id})`}</strong>: {stateLabels[company.status]??company.status}
    {company.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED'&&<div><p>A remoção externa está incerta. Esta consulta não repete a exclusão.</p>
      <button disabled={busy||disabled||reason.trim().length<5} onClick={()=>void reconcile(operation,company)}>Conferir remoção externa de {company.name??company.id}</button></div>}
    {company.status==='ACTION_REQUIRED'&&company.errorCode!=='EVOLUTION_CLEANUP_UNVERIFIED'&&<p>Abra esta empresa em Empresas → Plano e limites → Exclusão definitiva para revisar o impedimento e confirmar uma nova tentativa.</p>}
   </li>)}</ul>
  </section>)}
 </section>;
}
