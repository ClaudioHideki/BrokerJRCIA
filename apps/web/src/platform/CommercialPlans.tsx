import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CommercialAssignmentSchema, CommercialPlanCatalogSchema, type CommercialAssignment, type CommercialPlanVersion, type CommercialOverrides } from '@jrc/contracts';
import type { IntegrationRequest } from '../integrations/ChatwootPanel.js';
import { initialLimits, limitKeys, limitLabels, type Limits } from './model.js';

export function CommercialPlans({organizationId,request,admin,disabled,onAssigned}:{organizationId:string;request:IntegrationRequest;admin:boolean;disabled:boolean;onAssigned?:((assignment:CommercialAssignment)=>void)|undefined}){
 const [assignment,setAssignment]=useState<CommercialAssignment|null>(null),[catalog,setCatalog]=useState<CommercialPlanVersion[]>([]);
 const [selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[reload,setReload]=useState(0);
 const latest=useRef(request);latest.current=request;
 useEffect(()=>{
  let active=true;setAssignment(null);setError('');setCatalog([]);
  void Promise.all([latest.current(`/organizations/${organizationId}/commercial-plan`),admin?latest.current('/commercial-plans'):Promise.resolve({data:[]})]).then(([grant,plans])=>{
   if(!active)return;const current=CommercialAssignmentSchema.parse(grant),list=CommercialPlanCatalogSchema.parse(plans).data;
   setAssignment(current);setCatalog(list);setSelected(list.some(v=>v.id===current.planVersionId)?current.planVersionId!:list[0]?.id??'');
  }).catch(()=>{if(active)setError('Não foi possível consultar o plano. Atualize para tentar novamente.');});
  return()=>{active=false;};
 },[organizationId,admin,reload]);
 async function submit(event:FormEvent<HTMLFormElement>,kind:'assign'|'create'|'version'){
  event.preventDefault();if(!assignment)return;
  const form=new FormData(event.currentTarget);setBusy(true);setError('');
  try{
   if(kind==='assign'){
    const overrides:CommercialOverrides={};for(const key of limitKeys){const raw=String(form.get(key)??'');if(raw!=='')overrides[key]=Number(raw);}
    const flow=String(form.get('flowsEnabled'));if(flow==='true'||flow==='false')overrides.flowsEnabled=flow==='true';
    const updated=await latest.current(`/organizations/${organizationId}/commercial-plan`,'PUT',{planVersionId:selected,expectedRevision:assignment.revision,overrides});
    const current=CommercialAssignmentSchema.parse(updated);setAssignment(current);onAssigned?.(current);
   }else{
    const limits=Object.fromEntries(limitKeys.map(key=>[key,Number(form.get(key))])) as unknown as Limits;
    const base=catalog.find(v=>v.id===selected);
    if(kind==='version'&&!base)throw new Error('Select a plan');
    await latest.current(kind==='create'?'/commercial-plans':`/commercial-plans/${base!.planId}/versions`,'POST',{
     ...(kind==='create'?{name:String(form.get('name'))}:{expectedRevision:Math.max(...catalog.filter(v=>v.planId===base!.planId).map(v=>v.version))}),limits,flowsEnabled:form.get('flowsEnabled')==='on',
    });setReload(value=>value+1);
   }
  }catch{setError('Alteração não aplicada. A permissão ou revisão pode ter mudado; atualize antes de tentar novamente.');}
  finally{setBusy(false);}
 }
 return <section className="panel" aria-label="Plano comercial versionado">
  <h2>Contrato, uso e versões</h2><p>Limites por empresa. Reduzir a capacidade preserva os recursos e bloqueia novas admissões excedentes. Mensagem aceita não significa entregue.</p>
  <button className="button button--secondary" disabled={busy||disabled} onClick={()=>setReload(value=>value+1)}>Atualizar plano</button>
  {error&&<p role="alert">{error}</p>}
  {!assignment?<p role="status">Consultando contrato…</p>:<>
   <p>{assignment.name} · {assignment.version?`Versão ${assignment.version}`:'Configuração individual'} · Revisão {assignment.revision}</p>
   <table><thead><tr><th>Unidade</th><th>Contratado</th><th>Usado</th><th>Disponível</th></tr></thead><tbody>{limitKeys.map(key=>{
    const usageKey=({maxInstances:'connections',maxUsers:'users',messagesPerDay:'messagesAcceptedToday',maxPendingMessages:'pendingMessages'} as const)[key];
    const used=assignment.usage[usageKey],limit=assignment.limits[key];
    return <tr key={key}><th>{limitLabels[key]}</th><td>{limit}</td><td>{used}</td><td>{Math.max(0,limit-used)}{used>limit&&<span> · Acima do limite: {used-limit}</span>}</td></tr>;
   })}</tbody></table>
   <p>Mensagens aceitas no dia UTC. Pendências incluem envio e resultado desconhecido. Automações: {assignment.flowsEnabled?'habilitadas':'desabilitadas'}.</p>
   <p>Armazenamento: indisponível · IA: indisponível. Medições ainda não integradas; custos estimados não são fatura.</p>
   {admin&&<>
    <form key={`${organizationId}:${assignment.revision}`} className="admin-form" onSubmit={event=>void submit(event,'assign')}>
     <label>Versão do plano<select value={selected} onChange={event=>setSelected(event.target.value)} required><option value="">Selecione uma versão</option>{catalog.map(plan=><option key={plan.id} value={plan.id}>{plan.name} · v{plan.version}</option>)}</select></label>
     <fieldset><legend>Exceções explícitas para esta empresa</legend><p>Campo vazio usa o valor da versão selecionada.</p><div className="admin-form-grid">{limitKeys.map(key=><label key={key}>Exceção: {limitLabels[key]}<input type="number" name={key} min={1} max={100000000} step={1} defaultValue={assignment.overrides[key]??''}/></label>)}</div>
      <label>Exceção: Automações<select name="flowsEnabled" defaultValue={assignment.overrides.flowsEnabled===undefined?'':String(assignment.overrides.flowsEnabled)}><option value="">Usar plano</option><option value="true">Habilitar</option><option value="false">Desabilitar</option></select></label>
     </fieldset>
     <button className="button button--primary" disabled={disabled||busy||!selected}>Aplicar versão à empresa</button>
    </form>
    <details><summary>Manter catálogo administrativo</summary><p>Versões publicadas são preservadas. Uma nova versão só afeta a empresa quando atribuída explicitamente.</p>
     {(['create','version'] as const).map(kind=><form key={`${kind}:${selected}`} className="admin-form" onSubmit={event=>void submit(event,kind)}>
      <h3>{kind==='create'?'Novo plano':'Nova versão do plano selecionado'}</h3>
      {kind==='create'&&<label>Nome do plano<input name="name" required maxLength={80}/></label>}
      <div className="admin-form-grid">{limitKeys.map(key=><label key={key}>{limitLabels[key]}<input name={key} type="number" required min={1} max={100000000} defaultValue={kind==='version'?(catalog.find(v=>v.id===selected)?.limits[key]??initialLimits[key]):initialLimits[key]}/></label>)}</div>
      <label><input type="checkbox" name="flowsEnabled" defaultChecked={kind==='version'&&catalog.find(v=>v.id===selected)?.flowsEnabled}/> Habilitar automações</label>
      <button disabled={disabled||busy||(kind==='version'&&!selected)}>{kind==='create'?'Criar plano':'Publicar nova versão'}</button>
     </form>)}
    </details>
   </>}
  </>}
 </section>;
}
