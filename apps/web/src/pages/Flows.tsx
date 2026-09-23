import { useEffect, useRef, useState, type FormEvent } from 'react';
import { welcomeFlow, validateFlow, type FlowGraph, type FlowResult, type FlowState } from '@jrc/contracts';
import { ApiClientError } from '../api/client.js';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { FlowCanvas } from '../flows/FlowCanvas.js';
import { ChatwootFlowConnections } from '../flows/ChatwootFlowConnections.js';
import '../flows/flows.css';

interface Flow {id:string;name:string;graph:FlowGraph;revision:number;publishedVersion:number|null;updatedAt:string}
interface Template {id:string;name:string;description:string;graph:FlowGraph}
interface Channel {id:string;provider:string;flowId:string|null;hasAutomation:boolean}
interface Run {id:string;conversationId:string;version:number;status:string;errorCode:string|null;createdAt:string;trace:{nodeId:string;label:string;type:string}[]}
type Import={name:string;graph:FlowGraph;warnings:string[]};
function errorText(error:unknown){
 const code=error instanceof ApiClientError?error.code:'';
 const labels:Record<string,string>={
  FLOWS_DISABLED:'JRC Flows não está habilitado para esta empresa.',
  FLOW_CHANGED:'Este flow foi alterado em outra sessão. Volte à lista e reabra antes de salvar.',
  FLOW_REPLACE_REQUIRED:'Este canal já possui uma automação. Confirme a substituição para continuar.',
  FLOW_INVALID:'Há blocos ou conexões inválidas. Confira a validação do editor.',
  FLOW_IMPORT_INVALID:'Não foi possível converter este JSON. Use um JSON compatível com o editor JRC.',
 };
 return labels[code??'']??(error instanceof ApiClientError?error.message:'Não foi possível concluir. Tente novamente.');
}
const statusName=(status:string)=>({waiting:'Aguardando resposta',completed:'Concluído',handoff:'Atendimento humano',paused:'Pausado',failed:'Falhou'}[status]??status);
export function FlowsPage(){
 const {session,tenantRevision}=useSession();
 if(!session)return null;
 return <FlowsWorkspace key={session.activeOrganization.id+':'+tenantRevision} editable={['OWNER','ADMIN'].includes(session.activeOrganization.role)}/>;
}
function FlowsWorkspace({editable}:{editable:boolean}){
 const client=useApiClient();
 const [enabled,setEnabled]=useState<boolean|null>(null),[flows,setFlows]=useState<Flow[]>([]),[templates,setTemplates]=useState<Template[]>([]);
 const [selected,setSelected]=useState<Flow|null>(null),[baseline,setBaseline]=useState(''),[tab,setTab]=useState('editor');
 const [creating,setCreating]=useState<Import|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const [validation,setValidation]=useState<string[]|null>(null),[search,setSearch]=useState('');
 const [channels,setChannels]=useState<Channel[]>([]),[channelId,setChannelId]=useState(''),[replace,setReplace]=useState(false);
 const [runs,setRuns]=useState<Run[]>([]),[state,setState]=useState<FlowState|undefined>(),[chat,setChat]=useState<{from:string;text:string}[]>([]),[message,setMessage]=useState(''),[trace,setTrace]=useState<FlowResult['trace']>([]);
 const inFlight=useRef(false),file=useRef<HTMLInputElement>(null);
 const dirty=selected?JSON.stringify({name:selected.name,graph:selected.graph})!==baseline:false;
 const failures=selected?validateFlow(selected.graph):[];
 const snapshot=(flow:Flow)=>JSON.stringify({name:flow.name,graph:flow.graph});
 useEffect(()=>{
  const controller=new AbortController();
  void client.request<{enabled:boolean}>('/v1/flows/status',{signal:controller.signal}).then(async result=>{
   if(controller.signal.aborted)return;setEnabled(result.enabled);if(!result.enabled)return;
   const [list,library]=await Promise.all([client.request<{data:Flow[]}>('/v1/flows',{signal:controller.signal}),client.request<{data:Template[]}>('/v1/flows/library',{signal:controller.signal})]);
   if(!controller.signal.aborted){setFlows(list.data);setTemplates(library.data);}
  }).catch(e=>{if(!controller.signal.aborted)setError(errorText(e));});
  return ()=>controller.abort();
 },[client]);
 useEffect(()=>{
  if(!dirty)return;
  const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
  window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
 },[dirty]);
 async function action(work:()=>Promise<void>){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');setNotice('');
  try{await work();}catch(e){setError(errorText(e));}finally{setBusy(false);inFlight.current=false;}
 }
 const post=<T,>(path:string,body:unknown)=>client.request<T>(path,{method:'POST',body:JSON.stringify(body)});
 function select(flow:Flow){setSelected(flow);setBaseline(snapshot(flow));setTab('editor');setValidation(null);setError('');setNotice('');setState(undefined);setChat([]);setTrace([]);setChannels([]);setChannelId('');}
 function edit(graph:FlowGraph){if(selected){setSelected({...selected,graph});setValidation(null);setState(undefined);setChat([]);setTrace([]);}}
 async function create(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const name=String(new FormData(event.currentTarget).get('name')??'');
  if(!creating)return;const graph=creating.graph;
  await action(async()=>{const flow=await post<Flow>('/v1/flows',{name,graph});setFlows(current=>[flow,...current]);setCreating(null);select(flow);});
 }
 async function save(){if(!selected)return;const flow=selected;await action(async()=>{
  const result=await client.request<Flow>('/v1/flows/'+flow.id,{method:'PUT',body:JSON.stringify({name:flow.name,graph:flow.graph,revision:flow.revision})});
  setSelected(result);setBaseline(snapshot(result));setFlows(current=>current.map(f=>f.id===result.id?result:f));setNotice('Rascunho salvo.');
 });}
 async function switchTab(next:string){
  setTab(next);setError('');if(!selected)return;
  if(next==='connections')await action(async()=>{const result=await client.request<{data:Channel[]}>('/v1/flows/channels');setChannels(result.data);setChannelId(result.data[0]?.id??'');setReplace(false);});
  if(next==='runs')await action(async()=>{setRuns((await client.request<{data:Run[]}>('/v1/flows/'+selected.id+'/runs')).data);});
 }
 async function sendTest(event:FormEvent){
  event.preventDefault();if(!selected||!message.trim())return;const text=message;
  await action(async()=>{const result=await post<FlowResult>('/v1/flows/'+selected.id+'/simulate',{text,...(state?{state}:{})});setChat(current=>[...current,{from:'Você',text},...result.texts.map(t=>({from:'Flow',text:t}))]);setState({status:result.status,nodeId:result.nodeId,variables:result.variables,steps:result.steps});setTrace(result.trace);setMessage('');});
 }
 async function importFile(selectedFile:File){
  if(selectedFile.size>2000000){setError('Selecione um JSON de até 2 MB.');return;}
  await action(async()=>{const result=await post<Import>('/v1/flows/import-preview',{content:await selectedFile.text()});setCreating(result);});
 }
 if(enabled===false)return <section className="flows-page"><h1>JRC Flows</h1><p>JRC Flows não está habilitado para esta empresa.</p><p>O administrador da JRC pode liberar o módulo no cadastro da empresa.</p></section>;
 if(enabled===null)return <section className="flows-page"><h1>JRC Flows</h1><p>{error||'Carregando módulo…'}</p></section>;
 const channel=channels.find(c=>c.id===channelId);
 return <section className="flows-page">
  <header className="flows-heading"><div><span className="flows-eyebrow">AUTOMAÇÕES DA SUA EMPRESA</span><h1>{selected?'JRC Flows · Editor':'JRC Flows'}</h1><p>{selected?'Construa, teste e publique o caminho de cada atendimento.':'Crie chatbots no Broker e conecte-os aos canais da sua empresa.'}</p></div>
   {!selected&&editable&&<div className="flows-actions"><input ref={file} type="file" accept=".json,application/json" hidden onChange={e=>{const selectedFile=e.target.files?.[0];e.target.value='';if(selectedFile)void importFile(selectedFile);}}/><button type="button" disabled={busy} onClick={()=>file.current?.click()}>Importar JSON</button><button type="button" className="flows-primary" onClick={()=>setCreating({name:'Novo chatbot',graph:welcomeFlow(),warnings:[]})}>Novo flow</button></div>}
  </header>
  {error&&<div className="flows-alert flows-alert--error" role="alert">{error}</div>}
  {notice&&<div className="flows-alert" role="status">{notice}</div>}
  {creating&&<div className="flows-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="create-flow-title" className="flows-modal"><h2 id="create-flow-title">Criar flow</h2><form onSubmit={event=>void create(event)}><label>Nome do novo flow<input name="name" defaultValue={creating.name} required maxLength={120} autoFocus/></label><p>{creating.graph.nodes.length} blocos · {creating.graph.edges.length} conexões</p>{creating.warnings.length>0&&<details open><summary>Revisão da importação</summary><ul>{creating.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}{validateFlow(creating.graph).length>0&&<p className="flows-alert flows-alert--error">Este arquivo será salvo como rascunho. A publicação fica bloqueada até corrigir os blocos incompatíveis e as conexões.</p>}<div className="flows-actions"><button type="button" disabled={busy} onClick={()=>setCreating(null)}>Cancelar</button><button type="submit" disabled={busy} className="flows-primary">Criar flow</button></div></form></section></div>}
  {!selected?<>
   <div className="flows-overview"><div><strong>{flows.length}</strong><span>Flows criados</span></div><div><strong>{flows.filter(f=>f.publishedVersion).length}</strong><span>Com versão publicada</span></div><div><strong>{flows.filter(f=>!f.publishedVersion).length}</strong><span>Em preparação</span></div></div>
   <div className="flows-section-heading"><h2>Seus flows</h2><input aria-label="Buscar flows" placeholder="Buscar flows…" value={search} onChange={e=>setSearch(e.target.value)}/></div>
   <div className="flows-card-grid">{flows.filter(f=>f.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(f=><article className="flows-card" key={f.id}><span className="flows-badge">{f.publishedVersion?'Versão '+f.publishedVersion+' publicada':'Rascunho'}</span><h3>{f.name}</h3><p>{f.graph.nodes.length} blocos · Atualizado em {new Date(f.updatedAt).toLocaleDateString('pt-BR')}</p><button type="button" onClick={()=>select(f)}>Abrir editor</button></article>)}</div>
   {!flows.length&&<p className="flows-empty">Seu primeiro chatbot começa aqui. Crie um flow ou escolha um modelo abaixo.</p>}
   {editable&&<><h2>Biblioteca de modelos</h2><div className="flows-card-grid">{templates.map(t=><article className="flows-card flows-card--template" key={t.id}><span className="flows-badge">Pronto para personalizar</span><h3>{t.name}</h3><p>{t.description}</p><button type="button" onClick={()=>setCreating({name:t.name,graph:structuredClone(t.graph),warnings:[]})}>Usar {t.name}</button></article>)}</div></>}
  </>:<>
   <div className="flows-editor-heading"><button type="button" disabled={busy} onClick={()=>{if(!dirty||window.confirm('Descartar alterações não salvas e voltar à lista?')){setSelected(null);setNotice('');}}}>← Seus flows</button><label>Nome do flow<input value={selected.name} maxLength={120} disabled={!editable||busy} onChange={e=>setSelected({...selected,name:e.target.value})}/></label><span className="flows-badge">{dirty?'Alterações não salvas':selected.publishedVersion?'Versão '+selected.publishedVersion+' publicada':'Rascunho'}</span><div className="flows-actions">
    <button type="button" disabled={busy||dirty} onClick={()=>void action(async()=>{const doc=await client.request<unknown>('/v1/flows/'+selected.id+'/export');const url=URL.createObjectURL(new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=selected.name.replace(/[^a-zA-Z0-9_-]/g,'-')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);})}>Exportar JSON</button>
    <button type="button" onClick={()=>{setValidation(failures);setNotice(failures.length?'':'Estrutura validada. Salve e publique para conectar a um canal.');}}>Validar</button>
    {editable&&<><button type="button" disabled={busy||!dirty||!selected.name.trim()} onClick={()=>void save()}>Salvar</button><button type="button" className="flows-primary" disabled={busy||dirty||failures.length>0} onClick={()=>void action(async()=>{const published=await post<Flow>('/v1/flows/'+selected.id+'/publish',{revision:selected.revision});setSelected(published);setBaseline(snapshot(published));setFlows(current=>current.map(f=>f.id===published.id?published:f));setNotice('Versão publicada. Vincule um canal na aba Conexões para ativar o atendimento.');})}>Publicar versão</button></>}
   </div></div>
   <nav className="flows-tabs" aria-label="Seções do flow">{[['editor','Editor'],['connections','Conexões'],['test','Testar conversa'],['runs','Execuções']].map(([id,label])=><button type="button" key={id} aria-current={tab===id?'page':undefined} disabled={busy} onClick={()=>void switchTab(id!)}>{label}</button>)}</nav>
   {validation&&validation.length>0&&<div role="alert" className="flows-alert flows-alert--error"><strong>Corrija antes de publicar:</strong><ul>{validation.map((text,i)=><li key={i}>{text}</li>)}</ul></div>}
   {tab==='editor'&&<FlowCanvas key={selected.id} graph={selected.graph} onChange={edit} editable={editable&&!busy}/>}
   {tab==='connections'&&<div className="flows-panel"><h2>Conectar ao atendimento</h2><p>O flow responde pelo canal do Broker. A integração com Chatwoot ou JRC Conversas continua usando a conexão e a caixa de entrada configuradas para esta empresa.</p><p>Conversas que já aguardam uma resposta terminam na versão em que começaram. Novas sessões usam a última versão publicada.</p>{!selected.publishedVersion&&<p className="flows-alert">Publique uma versão validada antes de vincular um canal.</p>}
    {channels.length?<><label>Canal da empresa<select value={channelId} onChange={e=>{setChannelId(e.target.value);setReplace(false);}}>{channels.map(c=><option key={c.id} value={c.id}>{c.provider==='BAILEYS'?'WhatsApp QR':'WhatsApp oficial'} · {c.id.slice(0,8)}{c.flowId===selected.id?' · Este flow ativo':''}</option>)}</select></label>
     {channel?.hasAutomation&&channel.flowId!==selected.id&&<label className="flows-checkbox"><input type="checkbox" checked={replace} disabled={!editable} onChange={e=>setReplace(e.target.checked)}/> Substituir a automação atual deste canal por este flow</label>}
     {editable&&<div className="flows-actions"><button type="button" className="flows-primary" disabled={busy||!selected.publishedVersion||Boolean(channel?.hasAutomation&&channel.flowId!==selected.id&&!replace)} onClick={()=>void action(async()=>{await post('/v1/flows/'+selected.id+'/bind',{channelId,replaceAutomation:replace});setChannels((await client.request<{data:Channel[]}>('/v1/flows/channels')).data);setNotice('Flow vinculado. Novas mensagens deste canal podem iniciar o chatbot.');})}>Ativar neste canal</button>{channel?.flowId===selected.id&&<button type="button" disabled={busy} onClick={()=>void action(async()=>{await post('/v1/flows/'+selected.id+'/unbind',{channelId});setChannels((await client.request<{data:Channel[]}>('/v1/flows/channels')).data);setNotice('Flow desvinculado deste canal.');})}>Desativar neste canal</button>}</div>}
    </>:<p>Nenhum canal disponível. Crie e conecte uma instância em “Conexões”, ou configure um canal em “WhatsApp oficial”.</p>}
    <p className="flows-help">Atendimento humano tem prioridade. Use esta opção para automatizar diretamente o WhatsApp conectado ao Broker.</p>
   </div>}
   {tab==='connections'&&<ChatwootFlowConnections key={selected.id} flowId={selected.id} published={Boolean(selected.publishedVersion)} editable={editable}/>}
   {tab==='test'&&<div className="flows-test-grid"><div className="flows-panel"><h2>Testar conversa</h2><p>Teste o rascunho salvo sem enviar mensagens para clientes.</p>{dirty&&<p className="flows-alert">Salve as alterações para testar esta versão.</p>}<div className="flows-chat" aria-live="polite">{chat.length?chat.map((item,i)=><div key={i} className={'flows-chat-bubble '+(item.from==='Você'?'flows-chat-bubble--you':'')}><strong>{item.from}</strong><p>{item.text}</p></div>):<p>Envie “Olá” para iniciar o teste.</p>}</div>
    {state&&<p className="flows-badge">{statusName(state.status)}</p>}<form onSubmit={e=>void sendTest(e)}><label>Mensagem de teste<input value={message} maxLength={4096} onChange={e=>setMessage(e.target.value)} disabled={!editable||dirty||busy||Boolean(state&&state.status!=='waiting')}/></label><div className="flows-actions"><button type="submit" className="flows-primary" disabled={!editable||dirty||busy||!message.trim()||failures.length>0||Boolean(state&&state.status!=='waiting')}>Enviar teste</button><button type="button" onClick={()=>{setState(undefined);setChat([]);setTrace([]);setMessage('');}}>Reiniciar teste</button></div></form>
   </div><div className="flows-panel"><h3>Etapas desta mensagem</h3><ol>{trace.map((step,i)=><li key={i}>{step.label}</li>)}</ol><h3>Variáveis da conversa</h3><dl>{Object.entries(state?.variables??{}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></div></div>}
   {tab==='runs'&&<div className="flows-panel"><div className="flows-section-heading"><h2>Execuções nos canais</h2><button type="button" disabled={busy} onClick={()=>void switchTab('runs')}>Atualizar</button></div><p>Últimas 100 mensagens processadas. Os testes do editor ficam separados deste histórico.</p>{runs.length?<div className="flows-runs">{runs.map(run=><details key={run.id}><summary>{new Date(run.createdAt).toLocaleString('pt-BR')} · v{run.version} · {statusName(run.status)}</summary><p>Conversa: {run.conversationId}</p>{run.errorCode&&<p>Falha: {run.errorCode}</p>}<ol>{run.trace.map((step,i)=><li key={i}>{step.label}</li>)}</ol></details>)}</div>:<p>Ainda não há execuções deste flow nos canais.</p>}</div>}
  </>}
 </section>;
}
