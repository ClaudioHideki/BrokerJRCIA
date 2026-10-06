import {useEffect,useRef,useState,type FormEvent} from 'react';
import {LocalAttendanceDirectorySchema,LocalQueueItemSchema,LocalQueueSchema,LocalTeamsViewSchema,LocalTeamViewSchema,type LocalHumanTarget,type LocalQueueItem} from '@jrc/contracts';
import {ApiClientError,type ApiClient} from '../api/client.js';
type Props={client:ApiClient;organizationId:string;channelId:string;actorId:string;role:'OWNER'|'ADMIN'|'OPERATOR'|'VIEWER';onAssigned(row:LocalQueueItem):void;onAssignmentStart?():()=>boolean};
type Teams=ReturnType<typeof LocalTeamsViewSchema.parse>;
type Directory=ReturnType<typeof LocalAttendanceDirectorySchema.parse>;
const errorText=(error:unknown)=>error instanceof ApiClientError&&error.status===409?'O atendimento ou cadastro foi alterado. Atualize os dados e tente novamente.':error instanceof ApiClientError?error.message:'Não foi possível concluir esta ação no Broker.';

/** Tenant/channel/actor changes remount state and abort outstanding requests. */
export function LocalAttendancePanel(props:Props){
 if(props.role==='VIEWER')return null;
 return <PanelState key={`${props.organizationId}:${props.channelId}:${props.actorId}:${props.role}`} {...props}/>;
}
function PanelState({client,organizationId,channelId,actorId,role,onAssigned,onAssignmentStart}:Props){
 const admin=role==='OWNER'||role==='ADMIN',mounted=useRef(true),controllers=useRef(new Set<AbortController>()),lock=useRef(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [teams,setTeams]=useState<Teams|null>(null),[queue,setQueue]=useState<LocalQueueItem[]|null>(null),[directory,setDirectory]=useState<Directory|null>(null);
 const [newName,setNewName]=useState(''),[teamId,setTeamId]=useState(''),[name,setName]=useState(''),[status,setStatus]=useState<'ACTIVE'|'ARCHIVED'>('ACTIVE'),[members,setMembers]=useState<string[]>([]);
 const [targets,setTargets]=useState<Record<string,string>>({});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const controller of controllers.current)controller.abort();controllers.current.clear();};},[]);
 async function run(work:(signal:AbortSignal)=>Promise<()=>void>){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
  const controller=new AbortController();controllers.current.add(controller);
  try{const apply=await work(controller.signal);if(mounted.current&&!controller.signal.aborted)apply();}
  catch(cause){if(mounted.current&&!controller.signal.aborted)setError(errorText(cause));}
  finally{controllers.current.delete(controller);lock.current=false;if(mounted.current)setBusy(false);}
 }
 function selectedTeam(id:string,data=teams){
  const selected=data?.teams.find(t=>t.id===id);setTeamId(id);setName(selected?.name??'');setStatus(selected?.status??'ACTIVE');
  setMembers(selected?.memberIds.filter(member=>data?.agents.some(a=>a.id===member))??[]);
 }
 const selected=teams?.teams.find(t=>t.id===teamId);
 const loadTeams=()=>run(async signal=>{const data=LocalTeamsViewSchema.parse(await client.request('/v1/attendance/local-teams',{signal}));return()=>{setTeams(data);selectedTeam('',data);};});
 const loadQueue=()=>run(async signal=>{
  const data=LocalQueueSchema.parse(await client.request(`/v1/attendance/local-channels/${channelId}/queue`,{signal}));
  if(data.scope.organizationId!==organizationId||data.scope.channelId!==channelId)throw new ApiClientError('A fila não corresponde à empresa e caixa selecionadas.',409);
  const catalog=admin?LocalAttendanceDirectorySchema.parse(await client.request(`/v1/attendance/local-channels/${channelId}/catalog`,{signal})):null;
  if(catalog&&(catalog.scope.organizationId!==organizationId||catalog.scope.channelId!==channelId))throw new ApiClientError('O catálogo não corresponde à empresa e caixa selecionadas.',409);
  return ()=>{setQueue(data.data);setDirectory(catalog);setTargets({});};
 });
 const create=(event:FormEvent)=>{event.preventDefault();void run(async signal=>{
  const result=LocalTeamViewSchema.parse(await client.request('/v1/attendance/local-teams',{method:'POST',signal,body:JSON.stringify({name:newName})}));
  return()=>{setTeams(current=>current?{...current,teams:[...current.teams.filter(t=>t.id!==result.id),result]}:null);setNewName('');setNotice('Time criado.');};
 });};
 const save=(kind:'members'|'team')=>{
  if(!selected)return;
  void run(async signal=>{
   const result=LocalTeamViewSchema.parse(await client.request(`/v1/attendance/local-teams/${selected.id}${kind==='members'?'/members':''}`,{method:'PUT',signal,body:JSON.stringify(kind==='members'?{expectedRevision:selected.revision,memberIds:members}:{expectedRevision:selected.revision,name,status})}));
   return()=>{setTeams(current=>current?{...current,teams:current.teams.map(t=>t.id===result.id?result:t)}:null);setNotice(kind==='members'?'Membros atualizados.':'Time atualizado.');};
  });
 };
 const assign=(row:LocalQueueItem)=>void run(async signal=>{
  const navigationCurrent=onAssignmentStart?.()??(()=>true);
  const chosen=targets[row.conversationId]??`AGENT:${actorId}`;
  const target:LocalHumanTarget=!admin?{kind:'AGENT',agentId:actorId}:chosen==='QUEUE'?{kind:'QUEUE'}:chosen.startsWith('TEAM:')?{kind:'TEAM',teamId:chosen.slice(5)}:{kind:'AGENT',agentId:chosen.slice(6)};
  const result=LocalQueueItemSchema.parse(await client.request(`/v1/attendance/local-conversations/${row.conversationId}/assignment`,{method:'POST',signal,body:JSON.stringify({expectedSessionId:row.sessionId,sessionRevision:row.sessionRevision,target})}));
  if(result.conversationId!==row.conversationId||result.sessionId!==row.sessionId)throw new ApiClientError('A confirmação não corresponde ao atendimento selecionado.',409);
  return()=>{setQueue(current=>current?.map(item=>item.conversationId===result.conversationId?result:item)??null);setNotice(target.kind==='AGENT'&&target.agentId===actorId?'Atendimento assumido.':'Destino atualizado. A conversa aguarda atendimento.');if(navigationCurrent())onAssigned(result);};
 });
 const targetName=(row:LocalQueueItem)=>{const target=row.target;return target.kind==='QUEUE'?'Fila humana':target.kind==='TEAM'?directory?.teams.find(t=>t.id===target.teamId)?.name??'Time atribuído':target.agentId===actorId?'Você':directory?.agents.find(a=>a.id===target.agentId)?.email??'Agente atribuído';};
 return <section className="panel" aria-labelledby="local-attendance-title">
  <h2 id="local-attendance-title">Atendimento humano no Broker</h2>
  <p>Consulte a fila das caixas independentes e assuma uma conversa. A retomada do bot continua sendo uma ação separada.</p>
  <button className="button button--secondary" type="button" disabled={busy} onClick={()=>void loadQueue()}>Consultar fila do Broker</button>{' '}
  {admin&&<button className="button button--secondary" type="button" disabled={busy} onClick={()=>void loadTeams()}>Gerenciar times do Broker</button>}
  {busy&&<p role="status">Consultando ou salvando…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {queue&&<div>
   {queue.length===0&&<p>Nenhuma conversa aguardando atendimento local.</p>}
   {queue.map(row=><div className="state-card" key={row.sessionId}>
    <p>Conversa {row.conversationId} · {row.state==='HUMAN_ACTIVE'?'Em atendimento':'Aguardando atendimento'}</p><p>Destino: {targetName(row)}</p>
    {admin&&directory&&<label>Destino para a conversa {row.conversationId}<select disabled={busy} value={targets[row.conversationId]??`AGENT:${actorId}`} onChange={event=>setTargets(current=>({...current,[row.conversationId]:event.target.value}))}>
      <option value={`AGENT:${actorId}`}>Assumir com meu usuário</option><option value="QUEUE">Fila humana</option>
      {directory.teams.map(t=><option key={t.id} value={`TEAM:${t.id}`}>Time: {t.name}</option>)}
      {directory.agents.filter(a=>a.id!==actorId).map(a=><option key={a.id} value={`AGENT:${a.id}`}>Agente: {a.email}</option>)}
    </select></label>}
    <button type="button" className="button button--primary" disabled={busy} onClick={()=>assign(row)}>{admin?'Aplicar destino':'Assumir conversa'}</button>
   </div>)}
  </div>}
  {admin&&teams&&<div>
   <h3>Times locais</h3><p>Somente membros ativos com permissão de atendimento recebem novas transferências.</p>
   <form onSubmit={create}><label>Nome do novo time<input value={newName} maxLength={120} disabled={busy} onChange={event=>setNewName(event.target.value)}/></label><button type="submit" className="button button--primary" disabled={busy||!newName.trim()}>Criar time</button></form>
   <label>Time do Broker<select disabled={busy} value={teamId} onChange={event=>selectedTeam(event.target.value)}><option value="">Selecione um time</option>{teams.teams.map(t=><option key={t.id} value={t.id}>{t.name}{t.status==='ARCHIVED'?' (arquivado)':''}</option>)}</select></label>
   {selected&&<>
    <label>Nome do time<input value={name} maxLength={120} disabled={busy} onChange={event=>setName(event.target.value)}/></label>
    <label>Estado do time<select value={status} disabled={busy} onChange={event=>setStatus(event.target.value as 'ACTIVE'|'ARCHIVED')}><option value="ACTIVE">Ativo</option><option value="ARCHIVED">Arquivado</option></select></label>
    <button type="button" className="button button--secondary" disabled={busy||!name.trim()} onClick={()=>save('team')}>Salvar time</button>
    <fieldset disabled={busy}><legend>Membros do time</legend>{teams.agents.map(agent=><label key={agent.id}><input type="checkbox" checked={members.includes(agent.id)} onChange={event=>setMembers(current=>event.target.checked?[...current,agent.id]:current.filter(id=>id!==agent.id))}/>{agent.email}</label>)}</fieldset>
    <button type="button" className="button button--primary" disabled={busy} onClick={()=>save('members')}>Salvar membros</button>
   </>}
  </div>}
 </section>;
}
