import {useEffect,useRef,useState} from 'react';
import type {AutomationDefinitionV1,AutomationPublishedVersionV1} from '@jrc/contracts';
import {ApiClientError,type ApiClient} from '../api/client.js';
import {getAutomation,saveAutomation} from './api.js';
import {compareGraphs} from './graph-diff.js';

const titles={added:'Adicionado',removed:'Removido',configuration:'Configuração',presentation:'Apresentação',connection:'Conexão'};
const value=(item:unknown)=>item===undefined?'Ausente':typeof item==='string'?item:JSON.stringify(item,null,2);
export function assertVersionScope(item:AutomationDefinitionV1,organizationId:string,id:string){
 if(item.organizationId!==organizationId||item.id!==id)throw new Error('O rascunho não corresponde à empresa e à automação selecionadas.');
 return item;
}
/** Mount with a scope key so a pending mutation can never update another tenant/root. */
export function VersionComparison({client,item,versions,canEdit,draftKey}:{client:ApiClient;item:AutomationDefinitionV1;versions:AutomationPublishedVersionV1[];canEdit:boolean;draftKey:string}){
 const [draft,setDraft]=useState(item),[selected,setSelected]=useState(versions[0]?.version??0),[base,setBase]=useState('draft');
 const [confirmation,setConfirmation]=useState<AutomationDefinitionV1|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const live=useRef(true),pending=useRef(false),copyButton=useRef<HTMLButtonElement>(null);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const chosen=versions.find(version=>version.version===selected),baseline=base==='draft'?draft.draft.graph:versions.find(version=>String(version.version)===base)?.graph;
 const editable=canEdit&&draft.lifecycleStatus!=='ARCHIVED';
 const changes=chosen&&baseline?compareGraphs(chosen.graph,baseline):[];
 async function prepare(){
  if(!editable||!chosen||pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');
  try{
   const current=assertVersionScope(await getAutomation(client,item.id),item.organizationId,item.id);
   if(!live.current)return;
   if(current.lifecycleStatus==='ARCHIVED')throw new Error('Esta automação foi arquivada. O rascunho não pode ser substituído.');
   setDraft(current);setBase('draft');setConfirmation(current);
  }catch(reason){if(live.current)setError(reason instanceof Error?reason.message:'Não foi possível consultar o rascunho.');}
  finally{pending.current=false;if(live.current)setBusy(false);}
 }
 function dismiss(){setConfirmation(null);copyButton.current?.focus();}
 async function copy(){
  if(!editable||!chosen||!confirmation||pending.current)return;pending.current=true;setBusy(true);setError('');
  try{
   const saved=assertVersionScope(await saveAutomation(client,{...confirmation,draft:{revision:confirmation.draft.revision,graph:chosen.graph}}),item.organizationId,item.id);
   if(!live.current)return;
   setDraft(saved);
   try{sessionStorage.removeItem(draftKey);}catch{setError('A cópia foi salva, mas o cache local não pôde ser limpo. Abra o editor para conferir o rascunho salvo.');}
   dismiss();setNotice(`v${chosen.version} copiada para o rascunho. Revise no editor antes de publicar.`);
  }catch(reason){if(live.current){dismiss();setError(reason instanceof ApiClientError&&reason.status===409?'O rascunho mudou. Inicie uma nova cópia para consultar a revisão atual antes de confirmar.':reason instanceof Error?reason.message:'Não foi possível copiar a versão.');}}
  finally{pending.current=false;if(live.current)setBusy(false);}
 }
 if(!chosen)return <p>Nenhuma versão publicada.</p>;
 return <div className="automation-versions">
  <div className="version-selectors"><label>Versão a consultar<select disabled={busy||!!confirmation} value={selected} onChange={event=>{setSelected(Number(event.target.value));setNotice('');setError('');}}>{versions.map(version=><option key={version.version} value={version.version}>v{version.version}</option>)}</select></label>
   <label>Comparar com<select disabled={busy||!!confirmation} value={base} onChange={event=>setBase(event.target.value)}><option value="draft">Rascunho atual · revisão {draft.draft.revision}</option>{versions.map(version=><option key={version.version} value={version.version}>v{version.version}</option>)}</select></label></div>
  <p>v{chosen.version} · {new Date(chosen.publishedAt).toLocaleString('pt-BR')} · {chosen.graph.nodes.length} blocos. Checksum: <code>{chosen.checksum}</code></p>
  <h2>Alterações de v{chosen.version} para {base==='draft'?'o rascunho':'v'+base}</h2>
  {changes.length?<ol className="version-changes">{changes.map((change,index)=><li key={index}><h3>{titles[change.kind]} · {change.label}</h3><p>{change.field}</p><div className="version-values"><div><strong>v{chosen.version}</strong><pre>{value(change.before)}</pre></div><div><strong>{base==='draft'?'Rascunho':'v'+base}</strong><pre>{value(change.after)}</pre></div></div></li>)}</ol>:<p>Nenhuma diferença no grafo.</p>}
  {editable&&<button ref={copyButton} disabled={busy||!!confirmation} onClick={()=>void prepare()}>Copiar v{chosen.version} para rascunho</button>}
  {confirmation&&<section role="dialog" aria-label={`Substituir rascunho por v${chosen.version}?`} className="version-confirmation" onKeyDown={event=>{if(event.key==='Escape'&&!busy)dismiss();}}>
   <h2>Substituir rascunho por v{chosen.version}?</h2><p>O rascunho atual e as alterações locais não salvas serão substituídos. Publicações, vínculos e execuções continuam preservados.</p>
   <button autoFocus disabled={busy} onClick={dismiss}>Cancelar cópia</button> <button disabled={busy} onClick={()=>void copy()}>Confirmar cópia</button>
  </section>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 </div>;
}
