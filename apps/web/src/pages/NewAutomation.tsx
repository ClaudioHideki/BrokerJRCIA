import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { welcomeFlow, type AutomationGraphV1 } from '@jrc/contracts';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { createAutomation } from '../automations/api.js';
import { ImportReview, type ImportReport } from '../automations/ImportReview.js';
import { ApiClientError } from '../api/client.js';

type Preview={name:string;graph:AutomationGraphV1;report:ImportReport};
export function NewAutomationPage(){
  const client=useApiClient(),navigate=useNavigate(),{session,tenantRevision}=useSession();
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<Preview|null>(null);
  const generation=useRef(0),pending=useRef(false);
  useEffect(()=>{generation.current++;setName('');setPreview(null);setError('');setBusy(false);pending.current=false;return()=>{generation.current++;};},[session?.activeOrganization.id,tenantRevision]);
  const writable=Boolean(session&&['OWNER','ADMIN'].includes(session.activeOrganization.role));
  const fail=(reason:unknown)=>setError(reason instanceof ApiClientError?`${reason.message}${reason.requestId?` Solicitação: ${reason.requestId}`:''}`:reason instanceof Error?reason.message:'Não foi possível importar o arquivo.');
  async function importFile(file:File){
    if(pending.current||!writable)return;pending.current=true;setBusy(true);setError('');setPreview(null);const current=generation.current;
    try{
      if(file.size>2_000_000)throw new Error('Selecione um JSON de até 2 MB.');
      const content=await file.text();
      try{JSON.parse(content.replace(/^\uFEFF/,''));}catch{throw new Error('JSON inválido. Selecione o arquivo completo.');}
      if(current!==generation.current)return;
      const imported=await client.request<Preview>('/v1/automation-imports',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({source:'AUTO',content})});
      if(current===generation.current){setPreview(imported);setName(imported.name);}
    }catch(reason){if(current===generation.current)fail(reason);}
    finally{if(current===generation.current){pending.current=false;setBusy(false);}}
  }
  async function submit(event:FormEvent){
    event.preventDefault();if(pending.current||!writable||!name.trim())return;
    pending.current=true;setBusy(true);setError('');const current=generation.current;
    try{const item=await createAutomation(client,name.trim(),preview?.graph??welcomeFlow());
      if(current===generation.current)navigate(`/automations/${item.id}/edit`,{replace:true,state:preview?{importReport:preview.report}:null});
    }catch(reason){if(current===generation.current)fail(reason);}
    finally{if(current===generation.current){pending.current=false;setBusy(false);}}
  }
  return <section className="automation-page automation-narrow"><Link to="/automations">← Voltar para automações</Link><h1>Nova automação</h1>
    <p>Crie um chatbot JRC ou importe um arquivo JSON para continuar a edição.</p>
    {error&&<p role="alert" className="flows-alert flows-alert--error">{error}</p>}
    {!writable?<p>Somente administradores da empresa podem criar automações.</p>:<>
      <label>Arquivo JSON<input type="file" accept="application/json,.json" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(file)void importFile(file);event.target.value='';}}/></label>
      <p>O formato é identificado automaticamente. Arquivos com recursos externos podem exigir adaptação.</p>
      {preview&&<ImportReview report={preview.report}/>}
      <form onSubmit={event=>void submit(event)}><label>Nome da automação<input required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></label>
        <div className="flows-actions"><button className="flows-primary" disabled={busy||!name.trim()}>{busy?'Processando…':preview?'Importar rascunho e abrir editor':'Criar e abrir editor'}</button>
          {preview?<button type="button" disabled={busy} onClick={()=>{setPreview(null);setName('');setError('');}}>Cancelar importação</button>:<Link to="/automations">Cancelar</Link>}</div>
      </form>
    </>}
  </section>;
}
