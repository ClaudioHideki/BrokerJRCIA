import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { welcomeFlow, type AutomationGraphV1 } from '@jrc/contracts';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { createAutomation } from '../automations/api.js';
import { ImportReview, type ImportReport } from '../automations/ImportReview.js';
import { ApiClientError } from '../api/client.js';

type Preview={name:string;graph:AutomationGraphV1;report:ImportReport};
type PendingImport={content:string;idempotencyKey:string;persisted:Preview|null};
type PendingCreation={signature:string;idempotencyKey:string};
export function NewAutomationPage(){
  const client=useApiClient(),navigate=useNavigate(),{session,tenantRevision}=useSession();
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[runtimeEnabled,setRuntimeEnabled]=useState<boolean|null>(null);
  const generation=useRef(0),pending=useRef(false),pendingImport=useRef<PendingImport|null>(null),pendingCreation=useRef<PendingCreation|null>(null);
  useEffect(()=>{generation.current++;const current=generation.current;setName('');setPreview(null);setError('');setBusy(false);setRuntimeEnabled(null);pending.current=false;pendingImport.current=null;pendingCreation.current=null;
    if(session)void client.request<{enabled:boolean}>('/v1/automations/status').then(status=>{if(current===generation.current)setRuntimeEnabled(status.enabled);}).catch(reason=>{if(current===generation.current)setError(reason instanceof ApiClientError?`${reason.message}${reason.requestId?` Solicitação: ${reason.requestId}`:''}`:'Não foi possível verificar a disponibilidade das automações. Recarregue a página.');});
    return()=>{generation.current++;pendingImport.current=null;pendingCreation.current=null;};},[client,session?.activeOrganization.id,tenantRevision]);
  const writable=Boolean(session&&['OWNER','ADMIN'].includes(session.activeOrganization.role));
  const canCreate=writable&&runtimeEnabled===true;
  const fail=(reason:unknown)=>setError(reason instanceof ApiClientError?`${reason.message}${reason.requestId?` Solicitação: ${reason.requestId}`:''}`:reason instanceof Error?reason.message:'Não foi possível importar o arquivo.');
  async function importFile(file:File){
    if(pending.current||!canCreate)return;pending.current=true;setBusy(true);setError('');setPreview(null);pendingImport.current=null;pendingCreation.current=null;const current=generation.current;
    try{
      if(file.size>2_000_000)throw new Error('Selecione um JSON de até 2 MB.');
      const content=await file.text();
      try{JSON.parse(content.replace(/^\uFEFF/,''));}catch{throw new Error('JSON inválido. Selecione o arquivo completo.');}
      if(current!==generation.current)return;
      const imported=await client.request<Preview>('/v1/automation-imports/preview',{method:'POST',body:JSON.stringify({source:'AUTO',content})});
      if(current===generation.current){pendingImport.current={content,idempotencyKey:crypto.randomUUID(),persisted:null};setPreview(imported);setName(imported.name);}
    }catch(reason){if(current===generation.current)fail(reason);}
    finally{if(current===generation.current){pending.current=false;setBusy(false);}}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(pending.current||!canCreate||!name.trim())return;
    pending.current=true;setBusy(true);setError('');const current=generation.current;
    try{
      let confirmed:Preview|null=null;
      if(preview){const importState=pendingImport.current;if(!importState)throw new Error('Selecione novamente o arquivo para importar.');
        if(!importState.persisted)importState.persisted=await client.request<Preview>('/v1/automation-imports',{method:'POST',headers:{'Idempotency-Key':importState.idempotencyKey},body:JSON.stringify({source:'AUTO',content:importState.content})});
        confirmed=importState.persisted;}
      const graph=confirmed?.graph??welcomeFlow(),creationName=name.trim();
      const signature=JSON.stringify({name:creationName,graph});
      if(pendingCreation.current?.signature!==signature)pendingCreation.current={signature,idempotencyKey:crypto.randomUUID()};
      const item=await createAutomation(client,creationName,graph,pendingCreation.current.idempotencyKey);
      if(current===generation.current){pendingImport.current=null;navigate(`/automations/${item.id}/edit`,{replace:true,state:confirmed?{importReport:confirmed.report}:null});}
    }catch(reason){if(current===generation.current)fail(reason);}
    finally{if(current===generation.current){pending.current=false;setBusy(false);}}
  }
  return <section className="automation-page automation-narrow"><Link to="/automations">← Voltar para automações</Link><h1>Nova automação</h1>
    <p>Crie um chatbot JRC ou importe um arquivo JSON para continuar a edição.</p>
    {error&&<p role="alert" className="flows-alert flows-alert--error">{error}</p>}
    {runtimeEnabled===false&&<p role="alert">Automações temporariamente desativadas. Contate a administração JRC.</p>}
    {runtimeEnabled===null&&!error&&<p>Verificando disponibilidade das automações…</p>}
    {!writable?<p>Somente administradores da empresa podem criar automações.</p>:<>
      <label>Arquivo JSON<input type="file" accept="application/json,.json" disabled={busy||!canCreate} onChange={event=>{const file=event.target.files?.[0];if(file)void importFile(file);event.target.value='';}}/></label>
      <p>O formato é identificado automaticamente. Arquivos com recursos externos podem exigir adaptação.</p>
      {preview&&<ImportReview report={preview.report}/>}
      <form onSubmit={event=>void submit(event)}><label>Nome da automação<input required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></label>
        <div className="flows-actions"><button className="flows-primary" disabled={busy||!canCreate||!name.trim()}>{busy?'Processando…':preview?'Importar rascunho e abrir editor':'Criar e abrir editor'}</button>
          {preview?<button type="button" disabled={busy} onClick={()=>{pendingImport.current=null;pendingCreation.current=null;setPreview(null);setName('');setError('');}}>Cancelar importação</button>:<Link to="/automations">Cancelar</Link>}</div>
      </form>
    </>}
  </section>;
}
