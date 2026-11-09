import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router';
import {BoxRoutingConfigSchema,convertOiaToBoxTemplate,type BoxRoutingCatalog,type BoxRoutingConfig,type AutomationDefinitionV1,type ChannelV1} from '@jrc/contracts';
import type {ApiClient} from '../api/client.js';
import {ApiClientError} from '../api/client.js';
import {listChannels,getChannelAutomation} from '../channels/api.js';
import {getBoxRouting,saveBoxRouting} from './box-routing-api.js';
import {createAutomation} from './api.js';

const messages:Record<string,string>={FLOW_BOX_PROFILE_CHANGED:'A configuração foi alterada por outro administrador. Atualize antes de tentar novamente.',
 FLOW_BOX_SCHEMA_PENDING:'A atualização do Flow ainda não foi concluída neste servidor. Solicite a implantação da release compatível.',
 FLOW_BOX_SCOPE_CHANGED:'O vínculo da caixa ou a credencial mudou. Atualize os destinos e salve novamente.',FLOW_BOX_PROFILE_REQUIRED:'Configure e salve o atendimento desta caixa antes de ativar.',
 FLOW_BOX_AGENT_LIMIT:'Selecione até nove atendentes para este departamento.',FLOW_BOX_AGENT_UNAVAILABLE:'Um atendente deixou de pertencer ao time ou à caixa. Atualize os destinos.',
 FLOW_BOX_OIA_CONVERSION_REQUIRED:'Este grafo não corresponde ao padrão OIA suportado. A conversão precisa de revisão; o fluxo original foi preservado.',
 ATTENDANCE_REMOVE_COMPETING_AGENT_BOT:'Há outro AgentBot nesta caixa. Revise somente esta caixa no JRC e atualize os destinos.',
 ATTENDANCE_DISABLE_INBOX_GREETING:'Desative a saudação automática desta caixa no JRC para evitar mensagens duplicadas.',
 ATTENDANCE_DISABLE_INBOX_AUTO_ASSIGNMENT:'Desative a atribuição automática desta caixa no JRC antes de ativar o Flow.'};
const errorText=(e:unknown)=>e instanceof Error?(messages[e.message]??(e instanceof ApiClientError?e.message:'Não foi possível concluir. Atualize a configuração.')):'Não foi possível concluir.';
type Props={client:ApiClient;organizationId:string;items:AutomationDefinitionV1[];editable:boolean;initialChannel?:string};
type Binding=Awaited<ReturnType<typeof getChannelAutomation>>;
const configFor=(catalog:BoxRoutingCatalog):BoxRoutingConfig=>catalog.profile?.config??{schemaVersion:1,routes:catalog.routes.map(r=>({routeKey:r.routeKey,teamId:0,mode:r.mode,membership:'ALL',agentIds:[]}))};
export function BoxRoutingPanel({client,organizationId,items,editable,initialChannel}:Props){
 const [channels,setChannels]=useState<ChannelV1[]>([]),[cursor,setCursor]=useState<string|null>(null),[channelId,setChannelId]=useState(initialChannel??''),[automationId,setAutomationId]=useState('');
 const [data,setData]=useState<BoxRoutingCatalog|null>(null),[config,setConfig]=useState<BoxRoutingConfig|null>(null),[binding,setBinding]=useState<Binding|null>(null);
 const [savedRevision,setSavedRevision]=useState(0),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const generation=useRef(0),tenantGeneration=useRef(0),active=useRef(false),conversionKey=useRef<string|null>(null);
 const selected=channels.find(c=>c.id===channelId),channel=selected?.messagingChannelId??channelId,item=items.find(i=>i.id===automationId),version=item?.activeVersion??0;
 useEffect(()=>{
  const current=++tenantGeneration.current;setChannels([]);setCursor(null);setData(null);setConfig(null);setBinding(null);setError('');setNotice('');setAutomationId('');setChannelId(initialChannel??'');setBusy(false);active.current=false;
  if(editable)void listChannels(client,false,{pageSize:200}).then(page=>{if(current===tenantGeneration.current){setChannels(page.data.filter(c=>c.organizationId===organizationId));setCursor(page.nextCursor??null);}}).catch(e=>{if(current===tenantGeneration.current)setError(errorText(e));});
  return()=>{tenantGeneration.current++;};
 },[client,organizationId,editable,initialChannel]);
 useEffect(()=>{
  const current=++generation.current;setData(null);setConfig(null);setBinding(null);setSavedRevision(0);setDirty(false);setError('');setNotice('');conversionKey.current=null;
  if(!editable||!version||!channel||!selected?.destination)return;
  void Promise.all([getBoxRouting(client,organizationId,automationId,version,channel),getChannelAutomation(client,channelId)]).then(([catalog,owner])=>{
   if(current!==generation.current)return;setData(catalog);setBinding(owner);setSavedRevision(catalog.profile?.revision??0);
   setConfig(configFor(catalog));
  }).catch(e=>{if(current===generation.current)setError(errorText(e));});
  return()=>{generation.current++;};
 },[client,organizationId,editable,automationId,version,channel,channelId,selected?.id,selected?.destination?.integrationId]);
 async function refresh(){if(!version||!channel)return;const current=generation.current;setBusy(true);setError('');setBinding(null);
  try{const [catalog,owner]=await Promise.all([getBoxRouting(client,organizationId,automationId,version,channel),getChannelAutomation(client,channelId)]);
   if(current===generation.current){setData(catalog);setBinding(owner);setSavedRevision(catalog.profile?.revision??0);setConfig(configFor(catalog));setDirty(false);}}
  catch(e){if(current===generation.current)setError(errorText(e));}finally{if(current===generation.current)setBusy(false);}}
 const candidates=(route:BoxRoutingConfig['routes'][number])=>{
  const members=data?.teamMembers.find(t=>t.teamId===route.teamId)?.agents??[];
  return route.membership==='ALL'?[...members].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR')||a.id-b.id):route.agentIds.flatMap(id=>{const a=members.find(a=>a.id===id);return a?[a]:[];});
 };
 const pending:string[]=[];
 if(data){
  if(data.catalog.inboxPolicy.greetingEnabled!==false)pending.push('Confira e desative a saudação automática desta caixa no JRC.');
  if(data.catalog.inboxPolicy.autoAssignmentEnabled!==false)pending.push('Confira e desative a atribuição automática desta caixa no JRC.');
  if(data.catalog.capabilities.agentBot!=='SUPPORTED'||data.catalog.remoteBot!==null&&data.catalog.remoteBot.id!==data.catalog.brokerBotId)pending.push('Confira e remova o AgentBot concorrente desta caixa no JRC.');
  for(const route of config?.routes??[]){const label=data.routes.find(r=>r.routeKey===route.routeKey)?.labels.pt??route.routeKey,agents=candidates(route);
   if(!data.catalog.teams.some(t=>t.id===route.teamId))pending.push(`${label}: selecione um time.`);
   if(route.mode==='AGENT'&&(!agents.length||agents.length>9))pending.push(`${label}: selecione de um a nove atendentes do time e da caixa.`);
   if(route.mode==='AGENT'&&route.membership==='SELECTED'&&agents.length!==route.agentIds.length)pending.push(`${label}: um atendente selecionado não está mais disponível.`);
   if(new Set(agents.map(a=>a.name.trim().toLocaleLowerCase('pt-BR'))).size!==agents.length)pending.push(`${label}: existem nomes iguais. Ajuste os nomes no JRC para evitar ambiguidade.`);
  }
 }
 function change(index:number,patch:Partial<BoxRoutingConfig['routes'][number]>){setConfig(previous=>previous?{...previous,routes:previous.routes.map((r,i)=>i===index?{...r,...patch}:r)}:null);setDirty(true);setNotice('');}
 async function selectTeam(index:number,teamId:number){
  change(index,{teamId,agentIds:[]});
  if(!teamId||data?.teamMembers.some(t=>t.teamId===teamId)||config?.routes[index]?.mode==='TEAM')return;
  const current=generation.current;setBusy(true);setError('');
  try{const fresh=await getBoxRouting(client,organizationId,automationId,version,channel,teamId);
   if(data&&(JSON.stringify(data.catalog.scope)!==JSON.stringify(fresh.catalog.scope)||data.catalog.credentialRevision!==fresh.catalog.credentialRevision))throw new ApiClientError(messages.FLOW_BOX_SCOPE_CHANGED!,409);
   if(current===generation.current)setData(old=>old?{...fresh,teamMembers:[...old.teamMembers.filter(t=>!fresh.teamMembers.some(f=>f.teamId===t.teamId)),...fresh.teamMembers]}:fresh);}
  catch(e){if(current===generation.current){setBinding(null);setError(errorText(e));}}finally{if(current===generation.current)setBusy(false);}
 }
 async function save(){if(!config||active.current||pending.length)return;const current=generation.current;active.current=true;setBusy(true);setError('');
  try{const profile=await saveBoxRouting(client,organizationId,automationId,version,channel,savedRevision,BoxRoutingConfigSchema.parse(config));
   if(current===generation.current){setData(old=>old?{...old,profile}:old);setSavedRevision(profile.revision);setDirty(false);setNotice('Atendimento salvo. Revise a prévia e ative nesta caixa.');}}
  catch(e){if(current===generation.current)setError(errorText(e));}finally{if(current===generation.current){setBusy(false);active.current=false;}}}
 async function activate(){if(!binding||!savedRevision||dirty||active.current||pending.length)return;const current=generation.current;active.current=true;setBusy(true);setError('');
  try{await client.request(`/v1/automations/${automationId}/bindings`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({channelId:channel,version,expectedOwnerRevision:binding.ownerRevision,expectedProfileRevision:savedRevision})});
   if(current!==generation.current)return;setData(old=>old?.profile?{...old,profile:{...old.profile,activeRevision:savedRevision}}:old);setNotice('Novas entradas ativadas nesta caixa. Conversas em atendimento humano continuam pausadas.');setBinding(await getChannelAutomation(client,channelId));}
  catch(e){if(current===generation.current)setError(errorText(e));}finally{if(current===generation.current){setBusy(false);active.current=false;}}}
 async function admission(status:'ACTIVE'|'PAUSED'){
  if(!binding?.binding||active.current||status==='ACTIVE'&&(!data||dirty||pending.length||binding.binding.automationId!==automationId||data.routes.length>0&&!data.profile?.activeRevision))return;const current=generation.current;active.current=true;setBusy(true);setError('');
  try{const b=binding.binding;await client.request(`/v1/automations/${b.automationId}/bindings/${b.id}`,{method:'PATCH',body:JSON.stringify({status,revision:b.revision,expectedOwnerRevision:binding.ownerRevision,...(status==='ACTIVE'&&data?.routes.length?{expectedProfileRevision:data.profile!.activeRevision}: {})})});
   if(current===generation.current){setBinding(await getChannelAutomation(client,channelId));setNotice('Admissão de novas entradas atualizada; atendimentos humanos preservados.');}}
  catch(e){if(current===generation.current)setError(errorText(e));}finally{if(current===generation.current){setBusy(false);active.current=false;}}}
 async function convert(){if(!item||active.current)return;const current=generation.current;active.current=true;setBusy(true);setError('');
  try{const versions=await client.request<{data:Array<{version:number;graph:AutomationDefinitionV1['draft']['graph']}>}>(`/v1/automations/${item.id}/versions`);
   if(current!==generation.current)return;const source=versions.data.find(v=>v.version===version);if(!source)throw Error('AUTOMATION_VERSION_NOT_FOUND');
   const graph=convertOiaToBoxTemplate(source.graph);conversionKey.current??=crypto.randomUUID();
   const created=await createAutomation(client,`${item.name.slice(0,90)} — por caixa`,graph,conversionKey.current);
   if(current===generation.current)setNotice(`Novo rascunho criado: ${created.name}. Atualize a lista, revise e publique o novo modelo; o original foi preservado.`);}
  catch(e){if(current===generation.current)setError(errorText(e));}finally{if(current===generation.current){setBusy(false);active.current=false;}}}
 if(!editable)return <p>Um administrador configura os departamentos e ativa o Flow nas caixas. Os agentes atendem pelo JRC Conversas.</p>;
 return <section className="panel box-routing-panel" id="flow-boxes"><h2>Caixas vinculadas</h2>
  <p>Use o mesmo modelo em caixas diferentes. Cada caixa tem seus próprios times e atendentes do JRC Conversas.</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <div className="form-grid"><label>Automação para esta caixa<select value={automationId} disabled={busy} onChange={e=>setAutomationId(e.target.value)}><option value="">Selecione uma automação publicada</option>{items.filter(i=>i.activeVersion&&i.lifecycleStatus!=='ARCHIVED').map(i=><option key={i.id} value={i.id}>{i.name} · v{i.activeVersion}</option>)}</select></label>
  <label>Caixa WhatsApp<select value={channelId} disabled={busy} onChange={e=>setChannelId(e.target.value)}><option value="">Selecione uma caixa</option>{channels.map(c=><option key={c.id} value={c.id}>{c.identity.displayName??'Caixa'} · {c.identity.maskedAddress??'número não verificado'} · {c.destination?`${c.destination.name} / caixa ${c.destination.inboxId??'pendente'}`:'sem integração JRC'}</option>)}</select></label></div>
  {cursor&&<button disabled={busy} onClick={()=>{const current=generation.current;setBusy(true);void listChannels(client,false,{pageSize:200,cursor}).then(page=>{if(current===generation.current){setChannels(old=>[...old,...page.data.filter(c=>c.organizationId===organizationId&&!old.some(o=>o.id===c.id))]);setCursor(page.nextCursor??null);}}).catch(e=>{if(current===generation.current)setError(errorText(e));}).finally(()=>{if(current===generation.current)setBusy(false);});}}>Carregar mais caixas</button>}
  {selected&&!selected.destination&&<p>Esta caixa ainda precisa de integração com o JRC. <Link to={`/channels/${selected.id}?area=attendance`}>Configurar integração</Link></p>}
  {data&&!data.routes.length&&<div><p>Este fluxo usa destinos fixos. O original continua disponível no modo avançado do editor.</p><button disabled={busy} onClick={()=>void convert()}>Usar configuração da caixa — criar novo rascunho OIA</button></div>}
  {data&&config&&data.routes.length>0&&<>
   <p>Fonte dos atendentes: membros do time que também pertencem à caixa {data.catalog.scope.inboxId} do JRC.</p>
   {config.routes.map((route,index)=>{const definition=data.routes.find(r=>r.routeKey===route.routeKey)!,agents=candidates(route),available=data.teamMembers.find(t=>t.teamId===route.teamId)?.agents??[];
    return <fieldset key={route.routeKey} disabled={busy}><legend>{definition.labels.pt} / {definition.labels.en}</legend>
     <label>Time JRC — {definition.labels.pt}<select value={route.teamId||''} onChange={e=>void selectTeam(index,Number(e.target.value))}><option value="">Selecione o time</option>{data.catalog.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
     {route.mode==='TEAM'?<p>Transferência direta ao time; este modelo não oferece seleção individual de atendente.</p>:<>
      <label>Atendentes — {definition.labels.pt}<select value={route.membership} onChange={e=>change(index,{membership:e.target.value as 'ALL'|'SELECTED',agentIds:[]})}><option value="ALL">Todos os membros elegíveis</option><option value="SELECTED">Escolher e ordenar atendentes</option></select></label>
      {route.membership==='ALL'?<p>Novos membros elegíveis podem aparecer em novas sessões. Escolhas já apresentadas mantêm a ordem original.</p>:<div>{available.map(a=><label key={a.id}><input type="checkbox" checked={route.agentIds.includes(a.id)} onChange={e=>change(index,{agentIds:e.target.checked?[...route.agentIds,a.id]:route.agentIds.filter(id=>id!==a.id)})}/>{a.name}</label>)}</div>}
      <h3>Prévia dos atendentes — Português / English</h3><ol>{agents.map((a,i)=><li key={a.id}><span>{i+1} - {a.name}</span>{route.membership==='SELECTED'&&<><button type="button" aria-label={`Subir ${a.name}`} disabled={i===0} onClick={()=>{const ids=[...route.agentIds];[ids[i-1],ids[i]]=[ids[i]!,ids[i-1]!];change(index,{agentIds:ids});}}>↑</button><button type="button" aria-label={`Descer ${a.name}`} disabled={i===agents.length-1} onClick={()=>{const ids=[...route.agentIds];[ids[i],ids[i+1]]=[ids[i+1]!,ids[i]!];change(index,{agentIds:ids});}}>↓</button></>}</li>)}</ol><p>{agents.length+1} - Voltar / Return</p>
     </>}
    </fieldset>;
   })}
   {pending.length>0&&<ul aria-label="Pendências de ativação">{pending.map(p=><li key={p}>{p}</li>)}</ul>}
   <p>Expediente, retorno, opção inválida e inatividade seguem a versão publicada do modelo. Regras adicionais da central: não verificadas por este painel.</p>
   <p><Link to={`/channels/${channelId}?area=attendance`}>Abrir integração e administração de membros no JRC</Link> · <Link to={`/automations/${automationId}/versions`}>Conferir textos e expediente da versão {version}</Link></p>
   <div className="button-row"><button disabled={busy||pending.length>0} onClick={()=>void save()}>Salvar atendimento da caixa</button><button disabled={busy||pending.length>0||dirty||!savedRevision||!binding} onClick={()=>void activate()}>Ativar nesta caixa</button><button disabled={busy} onClick={()=>void refresh()}>Atualizar destinos e vínculo</button></div>
  </>}
  <section id="flow-operation"><h2>Operação</h2><p>Conexão WhatsApp: {selected?.transportStatus??'selecione uma caixa'}. Integração JRC: {selected?.destination?'vínculo cadastrado':'não configurada'}.</p>
   <p>Admissão: {binding?.binding?.status==='ACTIVE'?'novas entradas ativas':binding?.binding?.status==='PAUSED'?'novas entradas pausadas':'sem automação ativa confirmada'}. Perfil salvo: {savedRevision?`revisão ${savedRevision}`:'pendente'}. Perfil ativo: {data?.profile?.activeRevision?`revisão ${data.profile.activeRevision}`:'nenhum perfil ativado'}.</p>
   {binding?.binding&&<><button disabled={busy||binding.binding.status!=='ACTIVE'&&(!data||dirty||pending.length>0||binding.binding.automationId!==automationId||data.routes.length>0&&!data.profile?.activeRevision)} onClick={()=>void admission(binding.binding!.status==='ACTIVE'?'PAUSED':'ACTIVE')}>{binding.binding.status==='ACTIVE'?'Pausar novas entradas':'Retomar novas entradas'}</button><p>Retomar novas entradas conserva o perfil já ativo. Para usar outra revisão salva, confira a prévia e use Ativar nesta caixa.</p></>}
   <p>Conexão e ativação não comprovam entrega de mensagens. <Link to={automationId?`/automations/${automationId}/executions`:'/automations'}>Consultar execuções e entregas</Link>. Retomar uma conversa em atendimento humano continua sendo uma ação explícita nessa conversa.</p>
  </section>
 </section>;
}
