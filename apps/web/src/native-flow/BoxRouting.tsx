import {useEffect,useRef,useState} from 'react';
import {BoxRoutingConfigSchema,type BoxRoutingCatalog,type BoxRoutingConfig} from '@jrc/contracts';
import type {ApiClient} from '../api/client.js';
import {getBoxRouting,saveBoxRouting} from '../automations/box-routing-api.js';

/** Uses the same scoped catalog/profile as the Broker panel; never global channel APIs. */
export function NativeBoxRouting({client,organizationId,automationId,channelId,version,editable}:{
 client:ApiClient;organizationId:string;automationId:string;channelId:string;version:number;editable:boolean;
}){
 const [catalog,setCatalog]=useState<BoxRoutingCatalog|null>(null),[config,setConfig]=useState<BoxRoutingConfig|null>(null);
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
 const generation=useRef(0),saving=useRef(false);
 useEffect(()=>{
  const current=++generation.current;setCatalog(null);setConfig(null);setError('');setNotice('');setBusy(false);saving.current=false;
  void getBoxRouting(client,organizationId,automationId,version,channelId).then(value=>{
   if(current!==generation.current)return;
   setCatalog(value);setConfig(value.profile?.config??{schemaVersion:1,routes:value.routes.map(r=>({routeKey:r.routeKey,teamId:0,mode:r.mode,membership:'ALL',agentIds:[]}))});
  }).catch(()=>{if(current===generation.current)setError('Não foi possível consultar o atendimento desta caixa. Atualize a sessão antes de ativar.');});
  return()=>{generation.current++;};
 },[client,organizationId,automationId,channelId,version]);
 function change(index:number,patch:Partial<BoxRoutingConfig['routes'][number]>){
  setConfig(old=>old?{...old,routes:old.routes.map((r,i)=>i===index?{...r,...patch}:r)}:old);setNotice('');
 }
 async function team(index:number,teamId:number){
  change(index,{teamId,agentIds:[]});if(!catalog||!teamId)return;
  const current=generation.current;setBusy(true);setError('');
  try{const fresh=await getBoxRouting(client,organizationId,automationId,version,channelId,teamId);
   if(current===generation.current)setCatalog(old=>old?{...fresh,teamMembers:[...old.teamMembers.filter(t=>!fresh.teamMembers.some(n=>n.teamId===t.teamId)),...fresh.teamMembers]}:fresh);
  }catch{if(current===generation.current)setError('Não foi possível validar o time nesta caixa. Atualize os destinos.');}
  finally{if(current===generation.current)setBusy(false);}
 }
 async function save(){
  if(!config||!catalog||saving.current||!editable)return;
  const parsed=BoxRoutingConfigSchema.safeParse(config);if(!parsed.success){setError('Selecione um time e confira os atendentes de cada departamento.');return;}
  saving.current=true;const current=generation.current;setBusy(true);setError('');
  try{const profile=await saveBoxRouting(client,organizationId,automationId,version,channelId,catalog.profile?.revision??0,parsed.data);
   if(current===generation.current){setCatalog(old=>old?{...old,profile}:old);setNotice('Atendimento salvo. Preparar e vincular usará esta revisão; conversas em atendimento humano serão preservadas.');}
  }catch{if(current===generation.current)setError('A configuração mudou ou há um destino indisponível. Atualize e revise antes de salvar novamente.');}
  finally{if(current===generation.current){setBusy(false);saving.current=false;}}
 }
 if(catalog&&!catalog.routes.length)return null;
 return <section className="panel" aria-label="Atendimento por caixa">
  <h2>Atendimento por caixa</h2><p>Os times e agentes pertencem à caixa selecionada. Salvar não ativa o robô.</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {!catalog&&!error&&<p role="status">Consultando departamentos…</p>}
  {config?.routes.map((route,index)=>{const label=catalog?.routes.find(r=>r.routeKey===route.routeKey)?.labels.pt??route.routeKey;
   const members=catalog?.teamMembers.find(t=>t.teamId===route.teamId)?.agents??[];
   return <fieldset key={route.routeKey} disabled={!editable||busy}><legend>{label}</legend>
    <label>Time de {label}<select value={route.teamId||''} onChange={event=>void team(index,Number(event.target.value))}>
     <option value="">Selecione um time</option>{catalog?.catalog.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
    </select></label>
    {route.mode==='AGENT'&&<><label>Atendentes de {label}<select value={route.membership} onChange={event=>change(index,{membership:event.target.value as 'ALL'|'SELECTED',agentIds:[]})}>
     <option value="ALL">Todos os agentes do time nesta caixa</option><option value="SELECTED">Selecionar agentes</option>
    </select></label><p>Somente integrantes do time e desta caixa são elegíveis. Máximo de nove opções.</p>
    {route.membership==='SELECTED'&&members.map(a=><label key={a.id}><input type="checkbox" checked={route.agentIds.includes(a.id)} onChange={event=>change(index,{agentIds:event.target.checked?[...route.agentIds,a.id]:route.agentIds.filter(id=>id!==a.id)})}/>{a.name}</label>)}
    {!members.length&&route.teamId>0&&<p>Nenhum agente elegível foi confirmado neste time e caixa.</p>}</>}
   </fieldset>;
  })}
  {catalog&&<button disabled={!editable||busy} onClick={()=>void save()}>Salvar atendimento da caixa</button>}
 </section>;
}
