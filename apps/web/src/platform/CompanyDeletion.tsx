import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DeletionPreviewSchema, DeletionRequestedSchema, DeletionStatusSchema } from '@jrc/contracts';

type State='REQUESTED'|'BLOCKING'|'CLEANING_EXTERNAL'|'REMOVING_DATA'|'COMPLETED'|'ACTION_REQUIRED';
type Preview={resourceId:string;resourceName:string;kind:'ORGANIZATION';canDelete:boolean;blockers:string[];
  counts:Record<string,number>;externalEffects:string[];operationId:string|null;operationStatus:State|null};
type Operation={operationId:string;status:State;errorCode?:string|null;updatedAt?:string};
type Request=(path:string,method?:'GET'|'POST',body?:unknown)=>Promise<unknown>;

const stateLabel:Record<State,string>={REQUESTED:'Solicitação registrada',BLOCKING:'Aguardando pendências',
  CLEANING_EXTERNAL:'Conferindo sessões externas',REMOVING_DATA:'Removendo dados da empresa',
  COMPLETED:'Exclusão concluída',ACTION_REQUIRED:'Intervenção necessária'};
const failureLabel:Record<string,string>={EVOLUTION_CLEANUP_UNVERIFIED:'A remoção no Evolution não foi confirmada. Confira a sessão antes de tentar novamente.',
  EVOLUTION_INSTANCE_STILL_PRESENT:'A consulta confirmou que a sessão ainda existe. Confira o nome e confirme uma nova tentativa de exclusão.',
  LIFECYCLE_PENDING_WORK:'Há entregas em andamento ou resultado incerto. Reconcilie antes de repetir.',
  LIFECYCLE_PURGE_FAILED:'A limpeza local falhou. Confira o incidente e tente novamente.',
  LIFECYCLE_ACTOR_REVOKED:'A permissão de quem pediu a exclusão foi revogada. Um administrador global pode solicitar novamente.'};

export function CompanyDeletion({companyName,request,onDeleted,disabled=false}:{companyName:string;request:Request;
  onDeleted:()=>void;disabled?:boolean}){
  const [preview,setPreview]=useState<Preview|null>(null),[operation,setOperation]=useState<Operation|null>(null);
  const [name,setName]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),pending=useRef(false),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;generation.current++;};},[]);
  useEffect(()=>{let mounted=true;
    void request('/deletion-preview').then(value=>{
      if(!mounted)return;const parsed=DeletionPreviewSchema.safeParse(value);
      if(!parsed.success||parsed.data.kind!=='ORGANIZATION'){
        setError('Não foi possível validar o impacto da exclusão. Atualize a página.');return;
      }
      const next=parsed.data as Preview;setPreview(next);
      if(next.operationId&&next.operationStatus)setOperation({operationId:next.operationId,status:next.operationStatus});
    }).catch(()=>{if(mounted)setError('Não foi possível consultar o impacto da exclusão. Atualize a página.');});
    return()=>{mounted=false;};
  },[request]);
  useEffect(()=>{
    if(!operation||operation.status==='COMPLETED')return;
    let live=true;
    const poll=async()=>{if(pending.current)return;const version=++generation.current;try{const value=await request(`/deletion/${operation.operationId}`);
      const next=DeletionStatusSchema.safeParse(value);if(!next.success)throw new Error('INVALID_DELETION_STATUS');
      if(live&&version===generation.current)setOperation(next.data);}
      catch{if(live&&version===generation.current)setError('Não foi possível consultar a operação. Tente atualizar a página.');}};
    void poll();const timer=operation.status==='ACTION_REQUIRED'?undefined:setInterval(()=>void poll(),3000);
    return()=>{live=false;clearInterval(timer);};
  },[operation?.operationId,operation?.status,request]);
  useEffect(()=>{if(operation?.status==='COMPLETED')onDeleted();},[operation?.status,onDeleted]);
  async function submit(event:FormEvent){event.preventDefault();if(disabled||pending.current||operation?.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED'||!preview||name!==companyName||reason.trim().length<5||!preview.canDelete)return;
    pending.current=true;generation.current++;setBusy(true);setError('');
    try{const response=await request('/deletion','POST',{confirmationName:name,reason:reason.trim()});
      const next=DeletionRequestedSchema.safeParse(response);if(!next.success)throw new Error('INVALID_DELETION_REQUEST');
      if(live.current)setOperation(next.data);
    }catch{setError('A exclusão não foi iniciada. Confira pendências e tente novamente.');}
    finally{pending.current=false;if(live.current)setBusy(false);}
  }
  async function reconcile(){
    if(disabled||pending.current||!operation||reason.trim().length<5)return;
    pending.current=true;generation.current++;setBusy(true);setError('');
    try{const next=DeletionRequestedSchema.parse(await request(`/deletion/${operation.operationId}/reconcile`,'POST',{reason:reason.trim()}));
      if(live.current)setOperation(next);
    }catch{if(live.current)setError('A conferência não foi confirmada. Atualize o andamento antes de tentar novamente.');}
    finally{pending.current=false;if(live.current)setBusy(false);}
  }
  const active=operation&&operation.status!=='COMPLETED'&&operation.status!=='ACTION_REQUIRED';
  return <section className="panel" aria-label="Exclusão definitiva da empresa">
    <h2>Exclusão definitiva da empresa</h2>
    <p>Esta operação remove as conexões e os dados desta empresa no Broker. A conta, as caixas e as conversas no Chatwoot externo são preservadas.</p>
    {preview?<>
      <p>Impacto identificado: {preview.counts.users??0} usuários, {preview.counts.qrConnections??0} conexões QR e {preview.counts.metaConnections??0} conexões Meta.</p>
      <ul>{preview.externalEffects.map(effect=><li key={effect}>{effect}</li>)}</ul>
      {!preview.canDelete&&<p role="alert">{preview.blockers.includes('FLOW_REMOTE_BOT_ATTACHED')
        ? 'Há um robô Flow vinculado a uma caixa. Um proprietário ou administrador desta empresa deve abrir JRC Flows → selecionar o Flow → Conexões e desativar o vínculo. Confirme a remoção em JRC Conversas/Chatwoot → Configurações → Caixas de entrada → Configuração do Bot antes de consultar o impacto novamente.'
        : 'Há operações em andamento ou resultado incerto. Reconcilie as pendências antes de excluir.'}</p>}
    </>:<p role="status">Consultando impacto da exclusão…</p>}
    {operation&&<p role="status">{stateLabel[operation.status]}{operation.errorCode?`: ${failureLabel[operation.errorCode]??'Consulte a operação antes de tentar novamente.'}`:''}</p>}
    {operation?.status==='ACTION_REQUIRED'&&operation.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED'&&<div><p>A conferência consulta a sessão externa sem repetir a exclusão. Informe o motivo abaixo.</p>
      <button className="button button--secondary" disabled={disabled||busy||reason.trim().length<5} onClick={()=>void reconcile()}>Conferir remoção externa</button></div>}
    {error&&<p role="alert">{error}</p>}
    {!active&&operation?.status!=='COMPLETED'&&<form onSubmit={event=>void submit(event)}>
      <label htmlFor="company-deletion-name">Digite o nome da empresa</label>
      <input id="company-deletion-name" value={name} onChange={event=>setName(event.target.value)} autoComplete="off"/>
      <label htmlFor="company-deletion-reason">Motivo da exclusão</label>
      <textarea id="company-deletion-reason" value={reason} onChange={event=>setReason(event.target.value)} rows={3}/>
      <button className="button button--danger" disabled={disabled||busy||operation?.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED'||!preview?.canDelete||name!==companyName||reason.trim().length<5}>
        {operation?.status==='ACTION_REQUIRED'?'Retentar exclusão segura':'Excluir empresa definitivamente'}
      </button>
    </form>}
  </section>;
}
