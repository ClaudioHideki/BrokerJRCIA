import {useEffect,useRef,useState} from 'react';
import type {AutomationSubflowCatalogItem,FlowNode} from '@jrc/contracts';
import {DataVariableKeySchema} from '@jrc/contracts';
import type {ApiClient} from '../../api/client.js';
import {getSubflowCatalogPage} from '../api.js';
import {DataReferencePicker} from './DataReferencePicker.js';
import {JsonValueEditor} from './JsonValueEditor.js';

type Props={node:FlowNode;nodes:readonly FlowNode[];editable:boolean;client:ApiClient;organizationId:string;rootAutomationId:string;onChange:(data:FlowNode['data'])=>void};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function SubflowEditor(props:Props){return <PublishedSubflowEditor key={`${props.organizationId}:${props.rootAutomationId}:${props.node.id}`} {...props}/>;}
function PublishedSubflowEditor({node,nodes,editable,client,organizationId,rootAutomationId,onChange}:Props){
 const [items,setItems]=useState<AutomationSubflowCatalogItem[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null);
 const [loading,setLoading]=useState(editable),[loaded,setLoaded]=useState(false),[error,setError]=useState<string|null>(null);
 const [reference,setReference]=useState('message'),[inputName,setInputName]=useState('entrada');
 const generation=useRef(0),cursors=useRef(new Set<string>()),controller=useRef<AbortController|null>(null);
 const automationId=String(node.data.automationId??''),version=node.data.version===undefined?'':String(node.data.version);
 const input=object(node.data.input),timeout=node.data.timeoutMs==null?'':String(node.data.timeoutMs);
 const timeoutInvalid=timeout!==''&&(!Number.isInteger(Number(timeout))||Number(timeout)<100||Number(timeout)>30000);
 const known=items.some(item=>item.automationId===automationId&&String(item.version)===version);
 const automations=[...new Map(items.map(item=>[item.automationId,item.name])).entries()];
 const emit=(data:FlowNode['data'])=>{if(editable)onChange(data);};
 async function load(cursor?:string,reset=false){
  const ticket=reset?++generation.current:generation.current;
  if(reset){controller.current?.abort();cursors.current.clear();setItems([]);setNextCursor(null);setLoaded(false);}
  controller.current=new AbortController();setLoading(true);setError(null);
  try{
   const page=await getSubflowCatalogPage(client,organizationId,rootAutomationId,cursor,controller.current.signal);
   if(ticket!==generation.current)return;
   if(page.nextCursor&&(page.nextCursor===cursor||cursors.current.has(page.nextCursor)))throw new Error('PAGINATION_CYCLE');
   if(cursor)cursors.current.add(cursor);
   const merged=new Map((reset?[]:items).map(item=>[`${item.automationId}:${item.version}`,item]));
   for(const item of page.data){const key=`${item.automationId}:${item.version}`,prior=merged.get(key);if(prior&&prior.checksum!==item.checksum)throw new Error('IMMUTABLE_REFERENCE_CHANGED');merged.set(key,item);}
   setItems([...merged.values()]);setNextCursor(page.nextCursor);setLoaded(true);
  }catch{if(ticket===generation.current){setError('Não foi possível carregar as versões publicadas. Atualize e confira o acesso ao fluxo.');setLoaded(false);}}
  finally{if(ticket===generation.current)setLoading(false);}
 }
 useEffect(()=>{
  if(editable)void load(undefined,true);else{setLoading(false);setItems([]);setLoaded(false);}
  return()=>{generation.current++;controller.current?.abort();};
 },[client,organizationId,rootAutomationId,node.id,editable]);
 return <div className="automation-subflow-editor">
  <p>Selecione uma versão publicada. Alterações e novas versões da automação filha não substituem esta referência.</p>
  {loading&&<p role="status">Carregando versões publicadas…</p>}
  {error&&<p role="alert">{error}</p>}
  {loaded&&!loading&&!items.length&&<p>Nenhuma versão publicada disponível.</p>}
  {editable&&loaded&&!loading&&automationId&&version&&!known&&<p role="alert">A versão selecionada não está no catálogo carregado{nextCursor?'; carregue as próximas páginas para localizá-la':'. Escolha uma versão publicada disponível'}. A referência existente foi preservada.</p>}
  <label>Automação publicada do subfluxo<select disabled={!editable||loading||Boolean(error)||!items.length} value={automationId} onChange={event=>{
   const selected=items.find(item=>item.automationId===event.target.value);if(!selected)return;
   const {version:_oldVersion,...data}=node.data;emit({...data,automationId:selected.automationId});
  }}><option value="">Selecione uma automação</option>
   {automationId&&!automations.some(([id])=>id===automationId)&&<option value={automationId}>Referência armazenada</option>}
   {automations.map(([id,name])=><option key={id} value={id}>{name}</option>)}
  </select></label>
  <label>Versão publicada do subfluxo<select disabled={!editable||loading||Boolean(error)||!items.some(item=>item.automationId===automationId)} value={version} onChange={event=>{
   const selected=items.find(item=>item.automationId===automationId&&String(item.version)===event.target.value);if(selected)emit({...node.data,version:selected.version});
  }}><option value="">Selecione uma versão</option>
   {version&&!known&&<option value={version}>Versão {version} armazenada</option>}
   {items.filter(item=>item.automationId===automationId).map(item=><option key={item.version} value={String(item.version)}>Versão {item.version}</option>)}
  </select></label>
  {editable&&<><button type="button" disabled={loading} onClick={()=>void load(undefined,true)}>Atualizar versões</button>
   {nextCursor&&<button type="button" disabled={loading} onClick={()=>void load(nextCursor)}>Carregar mais versões</button>}</>}
  <label>Tempo limite do subfluxo (ms)<input inputMode="numeric" disabled={!editable} value={timeout} placeholder="10000" aria-invalid={timeoutInvalid} onChange={event=>{
   const value=event.target.value;emit({...node.data,timeoutMs:value.trim()!==''&&Number.isFinite(Number(value))?Number(value):value});
  }}/></label>
  {timeoutInvalid&&<p role="alert">Informe um número inteiro de 100 a 30000 ms. O valor não foi substituído automaticamente.</p>}
  <p>Sem valor configurado, o tempo limite é 10000 ms.</p>
  <h4>Entradas do subfluxo</h4>
  {node.data.input!==undefined&&(node.data.input===null||typeof node.data.input!=='object'||Array.isArray(node.data.input))&&<p role="alert">As entradas importadas foram preservadas; revise o mapeamento antes de publicar.</p>}
  {Object.entries(input).map(([name,value])=><fieldset key={name} disabled={!editable}>
   <JsonValueEditor value={value} label={'entrada '+name} editable={editable} onChange={next=>emit({...node.data,input:{...input,[name]:next}})}/>
   <button type="button" disabled={!editable} onClick={()=>emit({...node.data,input:Object.fromEntries(Object.entries(input).filter(([key])=>key!==name))})}>Remover entrada {name}</button>
  </fieldset>)}
  <label>Nome da entrada<input disabled={!editable} value={inputName} onChange={event=>setInputName(event.target.value)}/></label>
  <button type="button" disabled={!editable||!DataVariableKeySchema.safeParse(inputName).success||Object.hasOwn(input,inputName)} onClick={()=>emit({...node.data,input:{...input,[inputName]:''}})}>Adicionar entrada literal</button>
  <DataReferencePicker nodes={nodes} value={reference} label="Variável de origem da entrada" editable={editable} onChange={setReference}/>
  <button type="button" disabled={!editable||!DataVariableKeySchema.safeParse(inputName).success||!DataVariableKeySchema.safeParse(reference).success||Object.hasOwn(input,inputName)} onClick={()=>emit({...node.data,input:{...input,[inputName]:`{{${reference}}}`}})}>Adicionar entrada da variável</button>
  <p>O fluxo principal e o subfluxo compartilham as mesmas variáveis. As entradas sobrescrevem os nomes mapeados; valores criados ou alterados pela filha permanecem após o retorno. A saída Continuar usa o retorno já definido pelo fluxo.</p>
  {(node.data.inputSchema!==undefined||node.data.outputSchema!==undefined)&&<p>Os contratos avançados de entrada e saída deste bloco foram preservados.</p>}
 </div>;
}
