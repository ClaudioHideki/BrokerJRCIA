import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router';
import type {ChannelOperationProfile,ChannelOperationBlocker} from '@jrc/contracts';
import type {ApiClient} from '../api/client.js';
import {getChannelOperationProfile} from './api.js';
interface Props{client:ApiClient;organizationId:string;channelId:string;tenantRevision:number;}
const reasons:Record<ChannelOperationBlocker,string>={
 CHANNEL_NOT_ACTIVATED:'Ative o canal de mensagens desta caixa antes do teste.',
 CHANNEL_INACTIVE:'Esta caixa está arquivada ou em exclusão.',
 TRANSPORT_NOT_CONNECTED:'A conexão do WhatsApp ainda não está confirmada.',
 CENTRAL_SCOPE_UNVERIFIED:'O vínculo com a conta, origem e caixa da central precisa ser conferido.',
 DESTINATION_NOT_APPROVED:'O destino da central precisa de aprovação atual.',
 ACCOUNT_NOT_READY:'Confira a conta e a credencial da central.',
 CONNECTION_NOT_READY:'A caixa na central ainda não está pronta.',
 CAPABILITIES_UNVERIFIED:'As capacidades da central ainda não foram verificadas nesta credencial e revisão.',
 CAPABILITIES_UNSUPPORTED:'A central não oferece uma capacidade exigida pela integração.',
 CENTRAL_INTEGRATION_DISABLED:'A integração com central externa está desativada neste serviço.',
 LEGACY_EXECUTOR_PRESENT:'Há outro executor vinculado. Conclua a transição antes de ativar esta automação.',
 IDENTITY_UNVERIFIED:'Confirme a identidade atual do número e o acesso no controle da conexão.',
 CALLBACK_UNVERIFIED:'O webhook desta caixa ainda não foi confirmado na credencial e revisão atuais.',
};
export function ChannelOperationSetup(props:Props){
 return <Setup key={`${props.organizationId}:${props.tenantRevision}:${props.channelId}`} {...props}/>;
}
function Setup({client,organizationId,channelId}:Props){
 const [profile,setProfile]=useState<ChannelOperationProfile|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const controller=useRef<AbortController|null>(null);
 useEffect(()=>{setProfile(null);setError('');setBusy(false);return()=>controller.current?.abort();},[client]);
 async function load(){
  controller.current?.abort();const current=new AbortController();controller.current=current;
  setProfile(null);setBusy(true);setError('');
  try{const result=await getChannelOperationProfile(client,organizationId,channelId,current.signal);
   if(!current.signal.aborted&&controller.current===current)setProfile(result);
  }catch{if(!current.signal.aborted&&controller.current===current)setError('Não foi possível conferir a configuração desta empresa e caixa. Atualize a consulta.');}
  finally{if(!current.signal.aborted&&controller.current===current)setBusy(false);}
 }
 return <section className="panel" aria-label="Modo de operação da caixa"><h2>Modo e etapas de configuração</h2>
 <p>A caixa pode atender no Broker, no JRC Conversas ou em uma central Chatwoot autorizada. Confira o vínculo atual antes de prosseguir.</p>
 <button className="button button--secondary" disabled={busy} onClick={()=>void load()}>Conferir modo e configuração</button>
 {busy&&<p role="status">Conferindo configuração…</p>}{error&&<p role="alert">{error}</p>}
 {profile&&<><h3>{profile.mode==='STANDALONE'?'Atendimento no Broker':profile.mode==='JRC_MANAGED'?'JRC Conversas':profile.mode==='CHATWOOT_EXTERNAL'?'Chatwoot externo':'Modo ainda não confirmado'}</h3>
 <p>{profile.transport==='BROKER_TRANSPORT'?'O número está cadastrado para conexão pelo Broker.':profile.transport==='CENTRAL_TRANSPORT'?'O envio está configurado pela central.':'O transporte desta caixa ainda não foi confirmado.'}</p>
 {profile.central&&<p>Central: {profile.central.origin} · conta {profile.central.accountId} · caixa {profile.central.inboxId}</p>}
 <p role="status">{profile.readiness==='READY'?'A configuração está pronta para o teste.':'Conclua as pendências antes de testar a automação.'}</p>
 {profile.blockers.length>0&&<ul>{profile.blockers.map(reason=><li key={reason}>{reasons[reason]}</li>)}</ul>}
 <ol><li>Confirme a conexão do WhatsApp e a identidade do número.</li>
 {profile.mode==='STANDALONE'?<li>Organize times e agentes e consulte a fila em <Link to="/mensagens">Abrir atendimento no Broker</Link>.</li>:<li>Confira destino aprovado, conta, credencial, caixa e webhook em <Link to="/integracoes">Configurar central e caixa</Link>. A configuração existente exige escolha explícita antes de substituir um webhook.</li>}
 <li><Link to="/automations">Publicar e conferir a automação</Link>, depois vinculá-la nesta caixa.</li>
 <li>Teste mensagem recebida, resposta do bot, transferência, resposta humana e retomada.</li></ol>
 <p>A entrega real ainda precisa ser comprovada no WhatsApp e no destino escolhido. Grupos e chamadas precisam de testes próprios.</p>
 <p>Disponibilidade, publicação e vínculo do chatbot são conferidos separadamente. Este perfil verifica a configuração da conexão e da central.</p>
 {profile.capabilitiesObservedAt&&<p>Capacidades verificadas em {new Date(profile.capabilitiesObservedAt).toLocaleString('pt-BR')} para a credencial e revisão atuais.</p>}
 {profile.callbackObservedAt&&<p>Webhook desta caixa confirmado em {new Date(profile.callbackObservedAt).toLocaleString('pt-BR')}.</p>}
 <small>Configuração observada em {new Date(profile.observedAt).toLocaleString('pt-BR')}.</small></>}
 </section>;
}
