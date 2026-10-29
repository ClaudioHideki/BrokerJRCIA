import {HistoryImportPanel} from '../channels/HistoryImportPanel.js';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link,useParams} from 'react-router';
import type {AutomationBindingV1,AutomationDefinitionV1,ChannelV1,ConnectionAction} from '@jrc/contracts';
import {useApiClient,useSession} from '../auth/SessionProvider.js';
import {ApiClientError} from '../api/client.js';
import {listAutomations} from '../automations/api.js';
import {bindChannelAutomation,bindChannelDestination,disconnectChannel,getChannel,getChannelAutomation,pairChannel,patchChannel,reconnectChannel,refreshChannelStatus} from '../channels/api.js';
import {statusLabel,destinationStatusLabel} from './Channels.js';
import {ChannelDeletion} from '../channels/ChannelDeletion.js';
import {ChannelOperationSetup} from '../channels/ChannelOperationSetup.js';
import {WhatsAppGroups} from './WhatsAppGroups.js';
import {InstanceWorkspace,type InstanceWorkspaceArea} from '../connections/components/InstanceWorkspace.js';
type Area='overview'|'settings'|'events'|'attendance'|'flow'|'history';
const failures:Record<string,string>={
 CHANNEL_DISCONNECT_REQUIRED:'Desconecte o WhatsApp e confirme o status antes de arquivar.',CHANNEL_HAS_PENDING_WORK:'Há envios ou operações pendentes. Conclua ou reconcilie antes de arquivar.',
 CHANNEL_UNLINK_REQUIRED:'Desvincule a automação e pause o atendimento antes de arquivar.',CHANNEL_ARCHIVED:'Restaure esta caixa antes de operar.',
 CHATWOOT_ACCOUNT_NOT_CONFIGURED:'Configure primeiro a conta da central em JRC Conversas / Chatwoot.',CHATWOOT_ACCOUNT_NOT_READY:'Confira a conta e a credencial da central de atendimento.',
 INTEGRATION_HAS_HISTORY:'O vínculo possui histórico. Mantenha-o pausado para preservar mensagens e auditoria.',
 AUTOMATION_BINDING_CHANGED:'O vínculo mudou. Atualize a página antes de tentar novamente.',
 ATTENDANCE_OWNER_CHANGED:'O responsável pelo canal mudou. Atualize a página antes de tentar novamente.',
 ATTENDANCE_WORK_RECONCILIATION_REQUIRED:'Há um envio incerto do responsável anterior. Reconcilie o resultado antes de ativar outro chatbot.',
 CONNECT_RECONCILIATION_REQUIRED:'O estado do pareamento anterior ainda não foi confirmado. Atualize o status. Se continuar pendente, peça à equipe JRC a reconciliação antes de tentar outra conexão.',
};
export function ChannelDetailPage(){
 const {id=''}=useParams(),{session,tenantRevision}=useSession();
 return <ChannelDetail key={`${session?.activeOrganization.id??''}:${tenantRevision}:${id}`}/>;
}
function ChannelDetail(){
 const {id=''}=useParams(),client=useApiClient(),{session,tenantRevision}=useSession();
 const [ownerRevision,setOwnerRevision]=useState(0),[bindingLoaded,setBindingLoaded]=useState(false);const selectionEdited=useRef(false);
 const [channel,setChannel]=useState<ChannelV1|null>(null),[action,setAction]=useState<ConnectionAction|null>(null),[binding,setBinding]=useState<AutomationBindingV1|null>(null);
 const [area,setArea]=useState<Area>('overview'),[flowRequested,setFlowRequested]=useState(false);
 const [automations,setAutomations]=useState<AutomationDefinitionV1[]>([]),[catalogState,setCatalogState]=useState<'IDLE'|'LOADING'|'LOADED'|'ERROR'>('IDLE'),[automationId,setAutomationId]=useState(''),[displayName,setDisplayName]=useState(''),[destination,setDestination]=useState('');
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now());const pending=useRef(false);
 const [deleted,setDeleted]=useState(false);
 const canManage=Boolean(session&&['OWNER','ADMIN'].includes(session.activeOrganization.role)),canPair=Boolean(session&&session.activeOrganization.role!=='VIEWER'),archived=Boolean(channel?.archivedAt);
 async function load(includeBinding=flowRequested){const value=await getChannel(client,id);setChannel(value);setDisplayName(value.identity.displayName??'');if(includeBinding){const linked=await getChannelAutomation(client,id);setBinding(linked.binding);setOwnerRevision(linked.ownerRevision);setAutomationId(linked.binding?.automationId??'');setBindingLoaded(true);selectionEdited.current=false;}}
 useEffect(()=>{let live=true;void getChannel(client,id).then(value=>{if(live){setChannel(value);setDisplayName(value.identity.displayName??'');}}).catch(()=>{if(live)setError('Não foi possível carregar a caixa.');});return()=>{live=false;};},[client,id]);
 useEffect(()=>{if(!flowRequested)return;let live=true;setCatalogState('LOADING');
 void getChannelAutomation(client,id).then(value=>{if(live){setBinding(value.binding);setOwnerRevision(value.ownerRevision);if(!selectionEdited.current)setAutomationId(value.binding?.automationId??'');setBindingLoaded(true);}}).catch(()=>{if(live)setError('Não foi possível conferir o vínculo atual. Atualize a página antes de vincular uma automação.');});
 void listAutomations(client).then(value=>{if(live){setAutomations(value.filter(item=>item.activeVersion!==null&&item.lifecycleStatus!=='ARCHIVED'));setCatalogState('LOADED');}}).catch(()=>{if(live)setCatalogState('ERROR');});return()=>{live=false;};},[client,id,flowRequested]);
 useEffect(()=>{if(!action||action.type==='NONE')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[action]);
 const expiresAt=action&&'expiresAt' in action?new Date(action.expiresAt).getTime():0,expired=Boolean(expiresAt&&expiresAt<=now);
 useEffect(()=>{if(!action||action.type==='NONE'||expired||archived)return;let live=true;const timer=setInterval(()=>{void refreshChannelStatus(client,id).then(value=>{if(live){setChannel(value);if(value.transportStatus==='CONNECTED'){setAction(null);setNotice('WhatsApp conectado. Agora confira o vínculo de atendimento e a automação.');}}}).catch(()=>{if(live)setError('Não foi possível atualizar o pareamento. Use Atualizar status.');});},4000);return()=>{live=false;clearInterval(timer);};},[action,expired,archived,client,id]);
 async function run(work:()=>Promise<void>,success=''){if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');try{await work();if(success)setNotice(success);}catch(reason){setError(reason instanceof ApiClientError?(failures[reason.code??'']??reason.message):'Não foi possível concluir. Atualize e tente novamente.');}finally{pending.current=false;setBusy(false);}}
 async function pair(reconnect=false){await run(async()=>{const result=await(reconnect?reconnectChannel:pairChannel)(client,id,crypto.randomUUID());setNow(Date.now());setAction(result.action);setChannel(await getChannel(client,id));if(result.action.type==='NONE')setNotice(result.channel.transportStatus==='CONNECTED'?'WhatsApp já conectado.':'Solicitação em processamento. Atualize o status; aguarde a conclusão antes de iniciar outro pareamento.');});}
 async function disconnect(){if(!window.confirm('Desconectar este WhatsApp? Será necessário parear novamente. O histórico será preservado.'))return;await run(async()=>{const result=await disconnectChannel(client,id,crypto.randomUUID());setChannel(await getChannel(client,id));setAction(null);setNotice(result.pending?'Desconexão em processamento. Atualize o status.':'WhatsApp desconectado.');});}
 async function rename(event:FormEvent){event.preventDefault();await run(async()=>{setChannel(await patchChannel(client,id,{displayName:displayName.trim()}));},'Nome atualizado.');}
 async function bind(event:FormEvent){event.preventDefault();await run(async()=>{setChannel(await bindChannelDestination(client,id,{name:destination.trim(),replaceExistingWebhook:false}));},'Caixa vinculada. Confira a entrega no sistema de atendimento.');}
 async function bindAutomation(event:FormEvent){event.preventDefault();if(!bindingLoaded||catalogState!=='LOADED'||!automations.some(item=>item.id===automationId))return;await run(async()=>{await bindChannelAutomation(client,id,{automationId,expectedOwnerRevision:ownerRevision});await load();},'Automação vinculada. Novas mensagens usarão esta versão.');}
 async function refreshSetup(){await run(async()=>{
  setBindingLoaded(false);setCatalogState('LOADING');
  const [current,catalog]=await Promise.allSettled([load(true),listAutomations(client)]);
  if(catalog.status==='fulfilled'){setAutomations(catalog.value.filter(item=>item.activeVersion!==null&&item.lifecycleStatus!=='ARCHIVED'));setCatalogState('LOADED');}
  else setCatalogState('ERROR');
  if(current.status==='rejected')throw current.reason;
  if(catalog.status==='rejected')throw catalog.reason;
 });}
 async function changeBinding(status:'ACTIVE'|'PAUSED'|'DISABLED'){if(!binding||!bindingLoaded)return;if(!window.confirm(status==='DISABLED'?'Desvincular a automação? Novas mensagens não iniciarão este chatbot. Trabalhos ainda não enviados serão interrompidos; envios incertos precisam de reconciliação.':'Alterar recebimento de novas mensagens pelo chatbot? Execuções iniciadas continuam.'))return;await run(async()=>{await client.request(`/v1/automations/${binding.automationId}/bindings/${binding.id}`,{method:'PATCH',body:JSON.stringify({status,revision:binding.revision,expectedOwnerRevision:ownerRevision})});await load();},'Vínculo atualizado.');}
 async function destinationState(){if(!channel?.destination)return;const enabled=channel.humanStatus!=='READY';await run(async()=>{await client.request(`/v1/integrations/chatwoot/connections/${channel.destination!.integrationId}`,{method:'PATCH',body:JSON.stringify({enabled})});await load();},enabled?'Atendimento retomado.':'Atendimento pausado. Entregas pendentes foram preservadas.');}
 async function archive(){if(!window.confirm(archived?'Restaurar esta caixa? A conexão e os vínculos não serão ativados automaticamente.':'Arquivar este cadastro? Desconecte o WhatsApp, desvincule a automação e pause o atendimento antes. O histórico será preservado.'))return;await run(async()=>{await client.request(`/v1/channels/${id}/archive`,{method:'POST',body:JSON.stringify({archived:!archived})});await load();},archived?'Cadastro restaurado.':'Cadastro arquivado.');}
 const tabs:{id:Area;label:string}[]=[{id:'overview',label:'Visão geral'}];
 if(channel?.provider==='QR')tabs.push({id:'settings',label:'Configurações WhatsApp'});
 else if(channel?.provider==='META')tabs.push({id:'settings',label:'Configurações'});
 if(!archived){
  if(channel?.provider==='QR')tabs.push({id:'events',label:'Histórico operacional'});
  tabs.push({id:'attendance',label:'Atendimento'},{id:'flow',label:'Flow'});
  if(channel?.provider==='QR')tabs.push({id:'history',label:'Histórico e grupos'});
 }
 const visibleArea=tabs.some(tab=>tab.id===area)?area:'overview';
 const workspaceArea:InstanceWorkspaceArea|null=visibleArea==='overview'?'overview':visibleArea==='settings'?'settings':visibleArea==='events'?'events':null;
 function selectArea(next:Area){setArea(next);if(next==='flow')setFlowRequested(true);}
 if(deleted)return <section><h1>Conexão excluída</h1><p>A exclusão foi confirmada pelo servidor.</p><Link to="/channels">Voltar para caixas de entrada</Link></section>;
 return <section className="channel-detail" onClick={event=>{
  if(event.target instanceof Element&&event.target.closest('a[href="#channel-connect"]')){event.preventDefault();selectArea('overview');document.getElementById('channel-tab-overview')?.focus();}
 }}>
  <Link className="back-link" to="/channels">← Caixas de entrada</Link>
  {error&&<p role="alert" aria-label="Erro da caixa" className="notice notice--error">{error}</p>}
  {notice&&<p role="status" className="notice notice--success">{notice}</p>}
  {!channel?<p>Carregando caixa…</p>:<>
   <p className="eyebrow">{channel.provider==='CENTRAL'?'WhatsApp conectado na central':channel.provider==='QR'?'WhatsApp por QR Code':'WhatsApp oficial Meta'}</p>
   <h1>{channel.identity.displayName??'Caixa WhatsApp'}</h1>
   {archived&&<p className="notice">Cadastro arquivado. O histórico está preservado.</p>}
   <div className="workspace-navigation channel-workspace-tabs" role="tablist" aria-label="Áreas da conexão">
    {tabs.map((tab,index)=><button key={tab.id} id={'channel-tab-'+tab.id} type="button" role="tab"
     aria-selected={visibleArea===tab.id} aria-controls={'channel-area-'+tab.id} tabIndex={visibleArea===tab.id?0:-1}
     onClick={()=>selectArea(tab.id)} onKeyDown={event=>{
      const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
      if(next===null)return;event.preventDefault();const target=tabs[next]!;selectArea(target.id);document.getElementById('channel-tab-'+target.id)?.focus();
     }}>{tab.label}</button>)}
   </div>
   <div role="tabpanel" id={'channel-area-'+visibleArea} aria-labelledby={'channel-tab-'+visibleArea} className="channel-workspace-area">
    {visibleArea==='overview'&&<>
     <div className="metric-grid">
      <div className="metric"><small>WhatsApp</small><strong>{statusLabel[channel.transportStatus]}</strong><span>{channel.provider==='CENTRAL'?'Conexão física administrada na central':'Número: '+(channel.identity.maskedAddress??'Ainda não identificado')}</span></div>
      <div className="metric"><small>Automação JRC</small><strong>{channel.automationName??'Nenhuma selecionada'}</strong><span>{statusLabel[channel.automationStatus]}</span></div>
      <div className="metric"><small>Central de atendimento</small><strong>{channel.destination?.name??'Sem vínculo'}</strong><span>{destinationStatusLabel(channel.humanStatus)}</span></div>
     </div>
     <p><Link className="button button--secondary" to="/mensagens">Abrir conversas</Link></p>
     {!archived&&<section className="panel" id="channel-connect"><h2>Conexão do WhatsApp</h2>
      <div className="button-row"><button className="button button--secondary" disabled={busy} onClick={()=>void run(async()=>{setChannel(await refreshChannelStatus(client,id));},'Status atualizado.')}>Atualizar status</button>
       {channel.provider==='QR'&&canPair&&<><button className="button button--secondary" disabled={busy} onClick={()=>void pair(true)}>Reconectar</button>
        {channel.transportStatus!=='DISCONNECTED'&&<button className="button button--danger" disabled={busy} onClick={()=>void disconnect()}>Desconectar</button>}</>}
      </div>
      {channel.provider==='QR'&&canPair&&channel.transportStatus!=='CONNECTED'&&<>
       <p>No celular, abra WhatsApp → Dispositivos conectados → Conectar dispositivo.</p>
       <button className="button button--primary" disabled={busy} onClick={()=>void pair()}>Gerar QR Code</button>
       {expired?<p role="status">QR ou código expirado. Atualize o status antes de solicitar outro.</p>:action?.type==='QR_CODE'?<>
        <img className="channel-qr" src={action.encoding==='BASE64'?'data:image/png;base64,'+action.value:action.value} alt="QR Code para conectar o WhatsApp"/>
        <p>Expira em {Math.max(0,Math.ceil((expiresAt-now)/1000))} segundos.</p>
       </>:action?.type==='PAIRING_CODE'?<p>Código de pareamento: <strong>{action.code}</strong></p>:null}
      </>}
      {channel.provider==='META'&&<p>A conexão oficial depende da autorização dos ativos no cadastro da Meta. {canManage&&<Link to="/channels/meta/connect">Abrir configuração oficial</Link>}</p>}
      {channel.provider==='CENTRAL'&&<p>Confira a conexão do WhatsApp no JRC Conversas ou Chatwoot. {canManage&&<Link to={'/channels/new?provider=central&channel='+channel.id}>Gerenciar o vínculo do bot e a reversão</Link>}</p>}
     </section>}
    </>}
    {channel.provider==='QR'&&!archived&&<InstanceWorkspace instanceId={channel.providerReference.instanceId} area={workspaceArea}/>}
    {visibleArea==='settings'&&<>
     {!archived&&channel.provider==='QR'&&canManage&&<form className="panel form-grid" onSubmit={event=>void rename(event)}>
      <h2>Identificação</h2><label>Nome da caixa<input value={displayName} onChange={event=>setDisplayName(event.target.value)} required maxLength={100}/></label>
      <div className="button-row"><button className="button button--primary" disabled={busy||!displayName.trim()}>Salvar nome</button><button className="button button--secondary" type="button" disabled={busy} onClick={()=>setDisplayName(channel.identity.displayName??'')}>Cancelar edição</button></div>
     </form>}
     {channel.provider==='META'&&<section className="panel"><h2>WhatsApp oficial Meta</h2><p>Os ativos e a autorização deste canal são administrados no cadastro oficial.</p>{canManage?<Link to="/channels/meta/connect">Abrir configuração oficial</Link>:<p>Um administrador pode gerenciar a autorização da Meta.</p>}</section>}
     {canManage&&channel.provider==='QR'&&<section className="panel"><h2>Gerenciar cadastro</h2><p>Arquivar retira a caixa da lista ativa e preserva mensagens e auditoria. Não apaga caixas no sistema de atendimento.</p><button className="button button--danger" disabled={busy} onClick={()=>void archive()}>{archived?'Restaurar cadastro':'Arquivar cadastro'}</button></section>}
     {canManage&&channel.provider!=='CENTRAL'&&<section className="panel"><h2>Exclusão definitiva</h2><ChannelDeletion key={channel.id} path={'/v1/channels/'+channel.id} disabled={busy} onCompleted={()=>setDeleted(true)}
      request={(path,method='GET',body)=>client.request(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})})}/></section>}
    </>}
    {visibleArea==='attendance'&&!archived&&<>
     <section className="panel"><h2>Escolher onde a equipe atende</h2>
      <p>A equipe pode atender no Broker ou em uma central vinculada. No Broker, configure time e agente em Conversas. Para JRC Conversas ou Chatwoot, confira a conta e a caixa de destino.</p>
      <Link to="/mensagens">Abrir atendimento no Broker</Link>{' '}<Link to="/integracoes">Configurar conta, destino e caixas existentes</Link>
      {channel.destination?<><p>Caixa: <strong>{channel.destination.name}</strong> · {channel.destination.inboxId??'em configuração'}</p>
       {canManage&&channel.provider!=='CENTRAL'&&<button className="button button--secondary" disabled={busy} onClick={()=>void destinationState()}>{channel.humanStatus==='READY'?'Pausar atendimento':'Retomar atendimento'}</button>}
      </>:canManage&&channel.provider!=='CENTRAL'&&<form className="form-grid" onSubmit={event=>void bind(event)}>
       <label>Nome da nova caixa na central<input value={destination} onChange={event=>setDestination(event.target.value)} required maxLength={120}/></label>
       <button className="button button--primary" disabled={busy||!destination.trim()}>Vincular destino</button>
      </form>}
     </section>
     {canManage&&session&&<ChannelOperationSetup client={client} organizationId={session.activeOrganization.id} channelId={id} tenantRevision={tenantRevision}/>}
    </>}
    {visibleArea==='flow'&&!archived&&<>
     <section className="panel" id="channel-flow"><h2>Criar ou publicar o fluxo</h2>
      <p>Abra uma automação existente ou crie seu fluxo. Configure menu, captura de dados e transferência humana; salve, valide e publique a versão.</p>
      <p>O teste do editor é uma simulação. Depois da publicação, volte a esta caixa para vincular e testar no WhatsApp.</p>
      {canManage?<Link className="button button--secondary" to={'/automations?channel='+id}>Criar ou publicar fluxo</Link>:<p>Um administrador da empresa deve publicar e vincular o fluxo. Você pode conferir os estados e acompanhar as conversas conforme seu acesso.</p>}
     </section>
     <section className="panel" id="channel-bot-binding"><h2>Vincular bot à caixa</h2>
      <p>Selecione a versão publicada que receberá novas entradas desta caixa.</p>
      <p>Vincular permite novas entradas. Conversas em atendimento humano continuam com o bot pausado. Publicar, vincular ou retomar novas entradas não retoma essas conversas.</p>
      <Link to="/mensagens">Retomar uma conversa em atendimento humano</Link>
      {binding?<><p>{!bindingLoaded?'Estado anterior não confirmado · ':''}{statusLabel[binding.status]} · versão {binding.version}</p>
       {canManage&&<div className="button-row"><button disabled={busy||!bindingLoaded} onClick={()=>void changeBinding(binding.status==='ACTIVE'?'PAUSED':'ACTIVE')}>{binding.status==='ACTIVE'?'Pausar novas entradas':'Retomar novas entradas'}</button><button disabled={busy||!bindingLoaded} onClick={()=>void changeBinding('DISABLED')}>Desvincular automação</button><Link to={'/automations/'+binding.automationId+'/executions'}>Gerenciar execuções</Link></div>}
      </>:bindingLoaded?<p>Nenhuma automação vinculada.</p>:<p>Vínculo ainda não conferido.</p>}
      {canManage&&<form className="form-grid" onSubmit={event=>void bindAutomation(event)}>
       <label>Automação publicada<select value={automationId} disabled={busy||catalogState!=='LOADED'} onChange={event=>{selectionEdited.current=true;setAutomationId(event.target.value);}}>
        <option value="">Selecione um fluxo publicado</option>{automations.map(item=><option key={item.id} value={item.id}>{item.name} · v{item.activeVersion}</option>)}
       </select></label>
       <button className="button button--primary" disabled={busy||!bindingLoaded||catalogState!=='LOADED'||!automations.some(item=>item.id===automationId)}>Vincular automação</button>
      </form>}
      {canManage&&<>
       {!bindingLoaded&&<p>Conferindo o vínculo atual antes de permitir alterações…</p>}
       {catalogState==='LOADING'&&<p>Consultando fluxos publicados…</p>}
       {catalogState==='ERROR'&&<p role="alert">Não foi possível consultar os fluxos. Atualize a configuração antes de vincular a automação.</p>}
       {catalogState==='LOADED'&&!automations.length&&<p>Nenhuma versão publicada disponível. Crie ou abra um fluxo, salve, valide e publique; depois volte a esta caixa.</p>}
       <button type="button" className="button button--secondary" disabled={busy||catalogState==='LOADING'} onClick={()=>void refreshSetup()}>Atualizar fluxos e vínculo</button>
      </>}
     </section>
     <section className="panel" id="channel-test"><h2>Testar atendimento</h2>
      <p>{channel.provider==='CENTRAL'?'Envie uma nova mensagem de outro WhatsApp para comprovar o callback assinado desta caixa. Confira o diagnóstico atual e o evento recebido no Broker. Teste a resposta automática, a transferência humana e a resposta pública pela central.':'Confirme a conexão e a identidade do número. Se o atendimento usa uma central, confira também o vínculo, os horários de recebimento, a resposta pública e o webhook.'}</p>
      <p>Use uma conversa controlada. Se ela já está em atendimento humano, conclua o atendimento e escolha Retomar bot em Conversas antes de testar novamente.</p>
      <ol><li>Envie uma mensagem de outro WhatsApp e confira o recebimento.</li><li>Responda ao menu ou pergunta e confira a opção e o dado capturado na execução.</li><li>Teste a transferência para o destino humano configurado e confirme que o bot pausou.</li><li>Responda como atendente e confirme a entrega.</li><li>Retome explicitamente esta conversa e confira a resposta do bot.</li></ol>
      <p>Conexão, publicação e vínculo permitem preparar o teste; a entrega só é comprovada após observar as mensagens e os resultados.</p>
      <Link to="/mensagens">Abrir conversas para testar e retomar</Link>{' '}<Link to="/integracoes">Abrir controle e evidências de entrega</Link>
     </section>
    </>}
    {visibleArea==='history'&&!archived&&channel.provider==='QR'&&<>
     {canManage&&session&&<HistoryImportPanel client={client} organizationId={session.activeOrganization.id} channelId={id}/>}
     {channel.messagingChannelId&&canPair&&session&&<WhatsAppGroups key={channel.messagingChannelId} client={client} channelId={channel.messagingChannelId} canManage={canManage} eventsConfigurationOrganizationId={session.activeOrganization.id}/>}
     {!channel.messagingChannelId&&canPair&&<p>Os grupos estarão disponíveis depois que o recebimento desta conexão for preparado.</p>}
     {!canPair&&<p>Seu acesso permite consultar a conexão. Um administrador pode gerenciar o histórico e os grupos.</p>}
    </>}
   </div>
  </>}
 </section>;
}
