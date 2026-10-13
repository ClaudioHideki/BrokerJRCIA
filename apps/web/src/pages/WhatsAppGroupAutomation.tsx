import {useEffect,useRef,useState} from 'react';
import {WhatsAppGroupAutomationViewSchema,type WhatsAppGroupAutomationView} from '@jrc/contracts';
import {type ApiClient} from '../api/client.js';
const actions:Record<WhatsAppGroupAutomationView['nextAction'],string>={
 CONNECT_WHATSAPP:'Conecte o WhatsApp desta caixa de entrada.',UPDATE_GROUPS:'Atualize os grupos do WhatsApp para confirmar o número e a participação.',
 SELECT_GROUP:'Selecione este grupo no catálogo antes de ativar o bot.',CONFIGURE_EVENTS:'Use Atualizar grupos do WhatsApp para confirmar os eventos desta conexão.',
 ALLOW_GROUP_MESSAGES:'Na configuração desta conexão WhatsApp, permita mensagens de grupos. Depois atualize os grupos.',
 PUBLISH_AND_BIND_FLOW:'Publique uma automação e vincule-a à caixa de entrada para usar este bot.',CHOOSE_SUPPORTED_FLOW:'Escolha um fluxo com início, mensagem, menu e fim. Outros blocos ainda não são suportados em grupos.',
 ENABLE_GROUP_AUTOMATION:'Escolha a mensagem que inicia o menu e confirme a ativação neste grupo.',REVALIDATE_GROUP:'A conexão ou a configuração mudou. Atualize os grupos e confirme novamente a ativação.',
 RESUME_GROUP:'O atendimento está pausado. Retome quando o atendimento humano terminar.',RECONCILE_OUTCOME:'Há um envio sem confirmação. Confira o WhatsApp antes de decidir; esse envio não será repetido automaticamente.',
 READY:'Bot ativo neste grupo.',UNSUPPORTED_TRANSPORT:'Automação de grupos está disponível nesta etapa para a conexão QR do Broker. A integração de grupos pela central ainda precisa de validação.',
 UNSUPPORTED_GROUP:'Este grupo é de anúncios ou comunidade. O bot desta etapa requer um grupo comum com envio permitido.',
};
export function WhatsAppGroupAutomation({client,organizationId,channelId,groupJid,canManage}:{client:ApiClient;organizationId:string;channelId:string;groupJid:string;canManage:boolean}){
 const [view,setView]=useState<WhatsAppGroupAutomationView|null>(null),[trigger,setTrigger]=useState('/menu'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [decisionReason,setDecisionReason]=useState(''),[decisionConfirmed,setDecisionConfirmed]=useState(false);
 const epoch=useRef(0),controllers=useRef(new Set<AbortController>()),base='/v1/channels/'+encodeURIComponent(channelId)+'/whatsapp-group-automation';
 const valid=(data:unknown)=>{const parsed=WhatsAppGroupAutomationViewSchema.parse(data);if(parsed.organizationId!==organizationId||parsed.channelId!==channelId||parsed.groupJid!==groupJid)throw new Error('GROUP_CONTEXT_CHANGED');return parsed;};
 useEffect(()=>{const generation=++epoch.current;setView(null);setError('');setBusy(false);const abort=()=>{epoch.current++;for(const c of controllers.current)c.abort();controllers.current.clear();setView(null);setError('');setBusy(false);};
  setDecisionReason('');setDecisionConfirmed(false);
  const unregister=client.registerTenantPurge(()=>{abort();setDecisionReason('');setDecisionConfirmed(false);}),controller=new AbortController();controllers.current.add(controller);
  void client.request(base+'?groupJid='+encodeURIComponent(groupJid),{signal:controller.signal}).then(data=>{if(generation===epoch.current&&!controller.signal.aborted){const next=valid(data);setView(next);setTrigger(next.control?.triggerText??'/menu');}}).catch(()=>{if(generation===epoch.current&&!controller.signal.aborted)setError('Não foi possível conferir o bot deste grupo. Recarregue o catálogo.');}).finally(()=>controllers.current.delete(controller));
  return()=>{unregister();abort();};
 },[client,organizationId,channelId,groupJid]);
 async function mutate(action:'configure'|'pause'|'resume'){
  if(!view||busy||!canManage||action==='configure'&&(!view.flow||!view.identity||!trigger.trim()))return;const generation=epoch.current,controller=new AbortController();controllers.current.add(controller);setBusy(true);setError('');
  let body:Record<string,unknown>={groupJid,expectedRevision:view.control?.revision};
  if(action==='configure'){if(!view.flow||!view.identity||!trigger.trim())return;body={groupJid,triggerText:trigger.trim(),expectedOwnerRevision:view.flow.ownerRevision,expectedBindingId:view.flow.bindingId,expectedBindingRevision:view.flow.bindingRevision,expectedIdentityRevision:view.identity.revision,expectedIdentityFingerprint:view.identity.fingerprint,...(view.control?{expectedRevision:view.control.revision}:{})};}
  try{const data=await client.request(base+(action==='configure'?'':'/'+action),{method:action==='configure'?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});if(generation===epoch.current&&!controller.signal.aborted)setView(valid(data));}
  catch{if(generation===epoch.current&&!controller.signal.aborted)setError('A configuração não foi confirmada. Recarregue o catálogo para conferir o estado atual; não repita um envio.');}
  finally{controllers.current.delete(controller);if(generation===epoch.current)setBusy(false);}
 }
 async function recordDecision(kind:'dispatch-attempts'|'observations',id:string,revision:number,attemptIds?:string[]){
  if(!view||!canManage||busy||!decisionConfirmed||decisionReason.trim().length<5)return;
  const generation=epoch.current,controller=new AbortController();controllers.current.add(controller);setBusy(true);setError('');
  try{const data=await client.request(base+'/'+kind+'/'+encodeURIComponent(id)+'/abandon',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({groupJid,expectedRevision:revision,reason:decisionReason.trim(),...(kind==='observations'?{attemptIds:attemptIds??[]}:{})}),signal:controller.signal});
   if(generation===epoch.current&&!controller.signal.aborted){setView(valid(data));setDecisionReason('');setDecisionConfirmed(false);}}
  catch{if(generation===epoch.current&&!controller.signal.aborted)setError('A decisão não foi confirmada. Atualize o estado antes de tentar novamente. Nenhum reenvio foi solicitado.');}
  finally{controllers.current.delete(controller);if(generation===epoch.current)setBusy(false);}
 }
 return <section className="panel" aria-label="Bot do grupo"><h3>Bot do grupo</h3>
  <p>Só quem iniciou pode responder ao menu; todos os participantes veem as mensagens.</p>
  {error?<p role="alert" className="notice notice--error">{error}</p>:null}
  {!view&&!error?<p role="status">Conferindo o bot deste grupo…</p>:null}
  {view?<><p><strong>{view.subject}</strong></p>{view.flow?<p>{view.flow.name} · versão {view.flow.version}</p>:null}
   <p role="status">{actions[view.nextAction]}</p>
   {canManage&&['ENABLE_GROUP_AUTOMATION','REVALIDATE_GROUP'].includes(view.nextAction)&&view.flow?.supported&&view.identity?<>
    <label>Mensagem para iniciar o bot<input aria-label="Mensagem para iniciar o bot" value={trigger} maxLength={64} disabled={busy} onChange={e=>setTrigger(e.target.value)}/></label>
    <button type="button" className="button button--primary" disabled={busy||!trigger.trim()} onClick={()=>{void mutate('configure');}}>Ativar bot neste grupo</button>
   </>:null}
   {canManage&&view.nextAction==='READY'&&view.control?<button type="button" className="button button--secondary" disabled={busy} onClick={()=>{void mutate('pause');}}>Pausar bot para atendimento humano</button>:null}
   {canManage&&view.nextAction==='RESUME_GROUP'&&view.control?<button type="button" className="button button--primary" disabled={busy} onClick={()=>{void mutate('resume');}}>Retomar bot neste grupo</button>:null}
   {view.attempts.some(a=>['DISPATCHED','UNKNOWN'].includes(a.state))||view.observations.some(o=>o.blocking)?<><h4>Envios que precisam de conferência</h4>
    <p>Confira o resultado no WhatsApp. Encerrar uma tentativa registra a decisão e não confirma entrega nem repete a mensagem.</p>
    {canManage?<><label>Motivo da decisão sobre o envio<textarea aria-label="Motivo da decisão sobre o envio" value={decisionReason} maxLength={500} disabled={busy} onChange={e=>setDecisionReason(e.target.value)}/></label>
     <label><input type="checkbox" checked={decisionConfirmed} disabled={busy} onChange={e=>setDecisionConfirmed(e.target.checked)}/>Conferi o resultado e entendo que não haverá reenvio automático</label></>:null}
    {view.attempts.filter(a=>['DISPATCHED','UNKNOWN'].includes(a.state)).map(a=><div key={a.id}><p>{a.state==='DISPATCHED'?'Envio ainda em andamento. Aguarde a confirmação ou o prazo de recuperação.':'Envio sem confirmação.'}</p>
     {canManage&&a.state==='UNKNOWN'?<button type="button" className="button button--secondary" disabled={busy||!decisionConfirmed||decisionReason.trim().length<5} onClick={()=>{void recordDecision('dispatch-attempts',a.id,a.revision);}}>Encerrar tentativa sem reenviar</button>:null}</div>)}
    {view.observations.filter(o=>o.blocking).map(o=><div key={o.id}><p>Mensagem observada com resultado pendente.</p>{canManage?<button type="button" className="button button--secondary" disabled={busy||!decisionConfirmed||decisionReason.trim().length<5||o.attempts.some(a=>a.state==='DISPATCHED')} onClick={()=>{void recordDecision('observations',o.id,o.revision,o.attempts.filter(a=>a.state==='UNKNOWN').map(a=>a.id));}}>Encerrar observação sem reenviar</button>:null}</div>)}
   </>:null}
   {!canManage?<p>Somente administradores podem ativar, pausar ou retomar o bot.</p>:null}
  </>:null}
 </section>;
}
