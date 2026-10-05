import { useEffect, useState } from 'react';
import { AutomationHandoffConfigV1Schema, type AttendanceCatalog, type FlowNode } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../../api/client.js';
import { getHandoffCatalog, listHandoffConnections } from '../api.js';

type Props = { node: FlowNode; editable: boolean; client: ApiClient; organizationId: string; onChange: (data: FlowNode['data']) => void };
type Connections = Awaited<ReturnType<typeof listHandoffConnections>>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const errorText = (error: unknown) => error instanceof ApiClientError ? error.message : 'Não foi possível consultar os destinos. Atualize o catálogo e tente novamente.';
const destinationFor = (catalog: AttendanceCatalog) => ({integrationId:catalog.scope.integrationId,
  destinationRevision:catalog.scope.destinationRevision,accountId:catalog.scope.accountId,inboxId:catalog.scope.inboxId,credentialRevision:catalog.credentialRevision});

function readinessRequirements(catalog:AttendanceCatalog,teamId:unknown):string[] {
  const requirements:string[]=[];
  const disabledPolicy=(label:string,state:boolean|null)=>{
    if(state!==false)requirements.push(`Desative a ${label} na central e atualize os destinos.${state===null?' Esse estado não foi confirmado pela consulta.':''}`);
  };
  disabledPolicy('saudação automática da caixa',catalog.inboxPolicy.greetingEnabled);
  disabledPolicy('atribuição automática da caixa',catalog.inboxPolicy.autoAssignmentEnabled);
  if(catalog.capabilities.agentBot!=='SUPPORTED')requirements.push('Não foi possível confirmar a ausência de outro Agent Bot. Verifique o acesso e a compatibilidade da central e atualize os destinos.');
  if(catalog.remoteBot!==null)requirements.push(`Remova o Agent Bot ${catalog.remoteBot.name} da caixa na central e atualize os destinos para evitar dois robôs respondendo.`);
  const team=catalog.teams.find(candidate=>candidate.id===teamId);
  if(team)disabledPolicy(`atribuição automática do time ${team.name}`,team.autoAssignment);
  return requirements;
}

export function HandoffEditor({node,editable,client,organizationId,onChange}: Props) {
  const context = `${organizationId}:${node.id}`;
  const storedDestination = object(node.data.destination), storedTarget = object(node.data.target);
  const integrationId = typeof storedDestination.integrationId === 'string' ? storedDestination.integrationId : '';
  const [refresh,setRefresh] = useState(0);
  const requestKey = `${context}:${refresh}`;
  const [connectionsState,setConnections] = useState<{key:string;items:Connections;error?:string}|null>(null);
  const [catalogState,setCatalog] = useState<{key:string;value:AttendanceCatalog|null;error?:string}|null>(null);
  const connections = connectionsState?.key === requestKey ? connectionsState.items : null;
  const catalogKey = `${requestKey}:${integrationId}`;
  const catalog = catalogState?.key === catalogKey ? catalogState.value : null;
  const error = connectionsState?.key === requestKey && connectionsState.error || catalogState?.key === catalogKey && catalogState.error;
  useEffect(() => {
    if (!editable || !organizationId) return;
    const controller = new AbortController();
    void listHandoffConnections(client,controller.signal).then(items => {
      if (!controller.signal.aborted) setConnections({key:requestKey,items});
    }).catch(reason => {if (!controller.signal.aborted) setConnections({key:requestKey,items:[],error:errorText(reason)});});
    return () => controller.abort();
  },[client,editable,organizationId,requestKey]);
  useEffect(() => {
    if (!editable || !organizationId || !integrationId || !connections) return;
    if (!connections.some(connection => connection.id === integrationId)) {
      setCatalog({key:catalogKey,value:null,error:'A caixa selecionada está indisponível. Selecione outra caixa.'});return;
    }
    const controller = new AbortController();
    void getHandoffCatalog(client,organizationId,integrationId,controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog({key:catalogKey,value});
    }).catch(reason => {if (!controller.signal.aborted) setCatalog({key:catalogKey,value:null,error:errorText(reason)});});
    return () => controller.abort();
  },[client,editable,organizationId,integrationId,connections,catalogKey]);
  if (!editable) return <p>É necessária permissão de administrador para consultar ou alterar os destinos de atendimento.</p>;
  const teams = catalog?.capabilities.teams === 'SUPPORTED' ? catalog.teams : [];
  const agents = catalog?.capabilities.agents === 'SUPPORTED' && catalog.capabilities.inboxMembership === 'SUPPORTED' ? catalog.agents.filter(agent => agent.inboxMember) : [];
  const stale = Boolean(catalog && storedDestination.destinationRevision !== undefined && Object.entries(destinationFor(catalog)).some(([key,value]) => storedDestination[key] !== value));
  const teamMissing = Boolean(catalog && storedTarget.teamId != null && !teams.some(team => team.id === storedTarget.teamId));
  const agentMissing = Boolean(catalog && storedTarget.agentId != null && !agents.some(agent => agent.id === storedTarget.agentId));
  const requirements = catalog ? readinessRequirements(catalog,storedTarget.teamId) : [];
  const targetValue = (kind:'teamId'|'agentId') => stale ? '' : String(storedTarget[kind] ?? '');
  function selectTarget(kind:'teamId'|'agentId',value:string) {
    if (!editable || !catalog) return;
    const id = value ? Number(value) : null;
    if (id !== null && !(kind === 'teamId' ? teams : agents).some(item => item.id === id)) return;
    onChange({handoffVersion:1,destination:destinationFor(catalog),target:{teamId:kind==='teamId'?id:null,agentId:kind==='agentId'?id:null}});
  }
  return <fieldset className="automation-handoff-editor">
    <p>O bot pausa antes da transferência. A central precisa confirmar a atribuição ao time ou agente escolhido.</p>
    {node.data.handoffVersion === undefined && <p role="note">Bloco legado: selecione uma caixa e um destino para habilitar a transferência confirmada.</p>}
    {connections === null ? <p role="status">Carregando caixas de atendimento…</p> : <label>Caixa de atendimento<select value={integrationId} onChange={event=>{
      setCatalog(null);onChange(event.target.value?{handoffVersion:1,destination:{integrationId:event.target.value}}:{handoffVersion:1});
    }}><option value="">Selecione uma caixa</option>{integrationId&&!connections.some(item=>item.id===integrationId)&&<option value={integrationId}>Caixa indisponível</option>}{connections.map(connection=><option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>}
    {connections?.length === 0 && !error && <p>Nenhuma caixa pronta. Configure a integração JRC Conversas da empresa.</p>}
    {error && <p role="alert">{error}</p>}
    {integrationId && connections && !catalog && !error && <p role="status">Consultando times e agentes autorizados…</p>}
    {catalog && <>
      {requirements.length>0&&<div role="alert"><p>A publicação e a transferência ficam bloqueadas até revisar a central:</p><ul>{requirements.map(requirement=><li key={requirement}>{requirement}</li>)}</ul><p>O destino salvo será preservado enquanto você corrige essas configurações.</p></div>}
      {stale && <p role="alert">O destino mudou desde a configuração salva. Selecione novamente um time ou agente para revisar a nova vinculação.</p>}
      {teamMissing && <p role="alert">O time configurado está indisponível neste catálogo. Selecione outro destino.</p>}
      {agentMissing && <p role="alert">O agente configurado está indisponível ou não pertence mais à caixa. Selecione outro destino.</p>}
      <label>Time de atendimento<select disabled={catalog.capabilities.teams!=='SUPPORTED'} value={targetValue('teamId')} onChange={event=>selectTarget('teamId',event.target.value)}>
        <option value="">Nenhum time</option>{!stale&&teamMissing&&<option value={String(storedTarget.teamId)}>Time indisponível</option>}{teams.map(team=><option key={team.id} value={team.id}>{team.name}</option>)}
      </select></label>
      <label>Agente de atendimento<select disabled={catalog.capabilities.agents!=='SUPPORTED'||catalog.capabilities.inboxMembership!=='SUPPORTED'} value={targetValue('agentId')} onChange={event=>selectTarget('agentId',event.target.value)}>
        <option value="">Nenhum agente</option>{!stale&&agentMissing&&<option value={String(storedTarget.agentId)}>Agente indisponível</option>}{agents.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select></label>
      <p>Salvar o destino não confirma uma transferência. A publicação e cada execução conferem novamente a configuração na central.</p>
      <p>Escolha um time ou um agente. Selecionar um substitui o outro. Apenas agentes participantes desta caixa podem ser escolhidos.</p>
      {!AutomationHandoffConfigV1Schema.safeParse(node.data).success && <p role="alert">Selecione uma caixa e um time ou agente válido antes de publicar.</p>}
    </>}
    <button type="button" onClick={()=>setRefresh(value=>value+1)}>Atualizar destinos</button>
  </fieldset>;
}
