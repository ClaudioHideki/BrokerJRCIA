import {useEffect,useRef,useState} from 'react';
import {HttpQueryNodeConfigSchema,type FlowNode,type HttpCredentialCatalogPage} from '@jrc/contracts';
import type {ApiClient} from '../../api/client.js';
import {getHttpCredentialCatalogPage} from '../api.js';

type Credential=HttpCredentialCatalogPage['data'][number];
export function HttpQueryEditor({node,editable,client,organizationId,rootAutomationId,onChange}:{node:FlowNode;editable:boolean;client:ApiClient;organizationId:string;rootAutomationId:string;onChange:(data:Record<string,unknown>)=>void}){
 const [rows,setRows]=useState<Credential[]>([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[localError,setLocalError]=useState(''),[cursor,setCursor]=useState<string|null>(null);
 const generation=useRef(0),controller=useRef<AbortController|null>(null),seen=useRef(new Set<string>());
 const context=useRef(''),key=organizationId+':'+rootAutomationId+':'+node.id;context.current=key;
 const modern=node.data.httpConfigVersion!==undefined;
 const load=async(next?:string)=>{
  if(!editable||!modern)return;const current=++generation.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;setLoading(true);setError('');
  try{const page=await getHttpCredentialCatalogPage(client,organizationId,rootAutomationId,next,abort.signal);
   if(current!==generation.current||context.current!==key)return;
   if(page.nextCursor&&(page.nextCursor===next||seen.current.has(page.nextCursor)))throw new Error('PAGINATION_INVALID');
   if(!next)seen.current.clear();if(page.nextCursor)seen.current.add(page.nextCursor);
   setRows(previous=>[...new Map([...(next?previous:[]),...page.data].map(row=>[row.id,row])).values()]);setCursor(page.nextCursor);
  }catch{if(current===generation.current&&context.current===key){setError('Não foi possível carregar as credenciais. Atualize o catálogo ou confira seu acesso à empresa.');if(!next){setRows([]);setCursor(null);}}}
  finally{if(current===generation.current&&context.current===key)setLoading(false);}
 };
 useEffect(()=>{setRows([]);setCursor(null);setError('');seen.current.clear();void load();return()=>{generation.current++;controller.current?.abort();};},[client,organizationId,rootAutomationId,node.id,editable,modern]);
 const patch=(values:Record<string,unknown>)=>onChange({...node.data,...values});
 if(!modern)return <div><p>Este bloco conserva uma configuração histórica. Converta explicitamente para uma consulta GET delimitada e selecione novamente a credencial antes de publicar.</p><button type="button" disabled={!editable} onClick={()=>onChange({httpConfigVersion:1,method:'GET',url:String(node.data.url??''),credentialId:'',queryParameters:{},target:String(node.data.target??'http.result'),timeoutMs:15000,maxResponseBytes:32768,retryAttempts:0})}>Configurar consulta HTTPS</button></div>;
 const selected=rows.find(row=>row.id===node.data.credentialId),parameters=node.data.queryParameters&&typeof node.data.queryParameters==='object'&&!Array.isArray(node.data.queryParameters)?Object.entries(node.data.queryParameters as Record<string,unknown>):[];
 let policyMessage='';
 if(selected&&selected.revision!==node.data.credentialRevision)policyMessage='A credencial está desatualizada. Selecione o nome novamente para usar a revisão atual.';
 else if(selected&&!selected.allowedOrigins.length)policyMessage='Defina os destinos HTTPS permitidos para esta credencial em Credenciais e atualize este catálogo.';
 else if(selected)try{if(!selected.allowedOrigins.includes(new URL(String(node.data.url)).origin))policyMessage='Este destino não está permitido. Escolha um endereço permitido ou peça ao administrador para atualizar a política em Credenciais.';}catch{policyMessage='Informe um endereço HTTPS fixo, sem query, fragmento, token ou template.';}
 else if(node.data.credentialId&&!loading&&!error)policyMessage='A credencial selecionada não está disponível. Atualize o catálogo e escolha uma credencial ativa desta empresa.';
 const parsed=HttpQueryNodeConfigSchema.safeParse(node.data),validation=parsed.success?'':parsed.error.issues[0]?.message??'';
 const warning=error||localError||policyMessage||(!loading&&validation?'Revise os campos da consulta: '+validation:'');
 const replaceParameters=(values:Array<[string,unknown]>)=>patch({queryParameters:Object.fromEntries(values)});
 return <div><p>Consulta HTTPS GET. A URL é fixa; valores de variáveis entram somente nos parâmetros de consulta. O segredo permanece no cofre.</p>
  <label>Credencial da consulta<select disabled={!editable||loading||!rows.length} value={String(node.data.credentialId??'')} onChange={event=>{const row=rows.find(value=>value.id===event.target.value);if(row)patch({credentialId:row.id,credentialRevision:row.revision});else{const next:Record<string,unknown>={...node.data,credentialId:''};delete next.credentialRevision;onChange(next);}}}><option value="">Selecione pelo nome</option>{rows.map(row=><option key={row.id} value={row.id}>{row.name} · {row.type}</option>)}</select></label>
  <button type="button" disabled={!editable||loading} onClick={()=>void load()}>Atualizar credenciais</button>{cursor&&<button type="button" disabled={!editable||loading} onClick={()=>void load(cursor)}>Carregar mais credenciais</button>}
  {!loading&&!rows.length&&!error&&<p>Nenhuma credencial HTTP ativa. Cadastre uma credencial e seus destinos permitidos em Credenciais.</p>}
  {selected&&<p>Destinos permitidos: {selected.allowedOrigins.join(', ')||'configure em Credenciais'}</p>}
  {warning&&<p role="alert">{warning}</p>}
  <label>Endereço HTTPS da consulta<input disabled={!editable} maxLength={2048} value={String(node.data.url??'')} onChange={event=>patch({url:event.target.value})} placeholder="https://api.empresa.com/clientes"/></label>
  <label>Guardar resposta na variável<input disabled={!editable} value={String(node.data.target??'')} onChange={event=>patch({target:event.target.value})}/></label>
  <h4>Parâmetros de consulta</h4>{parameters.map(([name,value],index)=><div key={index}><label>Nome do parâmetro {index+1}<input disabled={!editable} maxLength={64} value={name} onChange={event=>{const next=event.target.value;if(parameters.some(([other],i)=>i!==index&&other===next)){setLocalError('Use nomes diferentes para os parâmetros.');return;}setLocalError('');replaceParameters(parameters.map((entry,i)=>i===index?[next,entry[1]]:entry));}}/></label><label>Valor do parâmetro {index+1}<input disabled={!editable} maxLength={2048} value={String(value??'')} onChange={event=>replaceParameters(parameters.map((entry,i)=>i===index?[entry[0],event.target.value]:entry))}/></label><button type="button" disabled={!editable} onClick={()=>replaceParameters(parameters.filter((_entry,i)=>i!==index))}>Remover parâmetro {index+1}</button></div>)}
  <button type="button" disabled={!editable||loading||parameters.length>=20} onClick={()=>{let index=1;while(parameters.some(([name])=>name==='parametro'+index))index++;replaceParameters([...parameters,['parametro'+index,'']]);}}>Adicionar parâmetro de consulta</button>
  <label>Tempo limite da consulta (ms)<input disabled={!editable} type="number" min={100} max={30000} value={String(node.data.timeoutMs??'')} onChange={event=>patch({timeoutMs:Number(event.target.value)})}/></label>
  <label>Tamanho máximo da resposta (bytes)<input disabled={!editable} type="number" min={1024} max={32768} value={String(node.data.maxResponseBytes??'')} onChange={event=>patch({maxResponseBytes:Number(event.target.value)})}/></label>
  <label>Novas tentativas de consulta<select disabled={!editable} value={String(node.data.retryAttempts??0)} onChange={event=>patch({retryAttempts:Number(event.target.value)})}>{[0,1,2].map(value=><option key={value}>{value}</option>)}</select></label>
 </div>;
}
