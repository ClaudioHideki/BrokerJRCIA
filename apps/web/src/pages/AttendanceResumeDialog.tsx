import { useEffect,useRef,useState } from 'react';
import { AttendanceResumeContextSchema,ResumeOperationViewSchema,type AttendanceResumeContext,type ResumeOperationView,type ResumeTarget } from '@jrc/contracts';
import { ApiClientError,type ApiClient } from '../api/client.js';
import { AttendanceDiagnosticNotice } from './AttendanceDiagnosticNotice.js';
const operationError:Record<string,string>={
  ATTENDANCE_DISABLE_INBOX_AUTO_ASSIGNMENT:'Desative a atribuição automática da caixa na central antes de retomar.',
  ATTENDANCE_DISABLE_INBOX_GREETING:'Desative a saudação automática da caixa na central antes de retomar.',
  ATTENDANCE_REMOVE_COMPETING_AGENT_BOT:'Desconecte o outro robô desta caixa antes de usar o Broker.',
  ATTENDANCE_RESUME_REMOTE_PROOF_REQUIRED:'Confirme o estado da conversa na central. O Broker não repetirá os comandos desta operação.',
  ATTENDANCE_WORK_RECONCILIATION_REQUIRED:'Confirme a entrega pendente antes de retomar a conversa.',
  ATTENDANCE_RESUME_CONTEXT_CHANGED:'O atendimento ou a configuração mudou. Reabra este diálogo e confira a conversa antes de tentar novamente.',
  ATTENDANCE_REMOTE_CONTROL_CHANGED:'Houve uma mudança no controle da conversa. Confira o atendimento antes de tentar novamente.',
  ATTENDANCE_OWNER_CHANGED:'O vínculo da automação mudou. Confira a caixa antes de tentar novamente.',AUTOMATION_RUNTIME_PAUSED:'A execução dos bots está pausada pela administração.',
};
export function AttendanceResumeDialog({conversationId,client,onConfirmed,onClose,pollIntervalMs=1000}:{
  conversationId:string;client:ApiClient;onConfirmed:()=>void;onClose:()=>void;pollIntervalMs?:number;
}){
  const [context,setContext]=useState<AttendanceResumeContext|null>(null),[operation,setOperation]=useState<ResumeOperationView|null>(null);
  const [choice,setChoice]=useState<ResumeTarget['kind']|''>(''),[menu,setMenu]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const lifetime=useRef(new AbortController()),lock=useRef(false),intent=useRef<{body:string;key:string}|null>(null),confirmed=useRef(false),panel=useRef<HTMLElement>(null);
  const onConfirmedRef=useRef(onConfirmed);onConfirmedRef.current=onConfirmed;
  useEffect(()=>{
    const controller=new AbortController();lifetime.current=controller;panel.current?.focus();
    void client.request(`/v1/attendance/conversations/${encodeURIComponent(conversationId)}/resume-context`,{signal:controller.signal})
      .then(value=>{if(controller.signal.aborted)return;const data=AttendanceResumeContextSchema.parse(value);setContext(data);setOperation(data.operation);})
      .catch(()=>{if(!controller.signal.aborted)setError('Não foi possível verificar a conversa. Reabra o diálogo para atualizar.');});
    return()=>controller.abort();
  },[client,conversationId]);
  useEffect(()=>{
    if(!operation)return;
    if(operation.state==='APPLIED'){if(!confirmed.current){confirmed.current=true;onConfirmedRef.current();}return;}
    if(operation.state!=='PENDING')return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{const data=ResumeOperationViewSchema.parse(await client.request(`/v1/attendance/resume-operations/${encodeURIComponent(operation.id)}`,{signal:controller.signal}));
        if(!controller.signal.aborted){setOperation(data);if(data.state==='PENDING')timer=setTimeout(()=>void poll(),pollIntervalMs);}
      }catch{if(!controller.signal.aborted)setError('Não foi possível consultar a retomada. A conversa continua sem confirmação; reabra este diálogo para conferir.');}
    };
    timer=setTimeout(()=>void poll(),pollIntervalMs);return()=>{controller.abort();clearTimeout(timer);};
  },[client,operation?.id,operation?.state,pollIntervalMs]);
  async function submit(){
    if(lock.current||!context||!choice||choice==='MENU'&&!menu)return;
    lock.current=true;setBusy(true);setError('');
    const target:ResumeTarget=choice==='MENU'?{kind:'MENU',nodeId:menu}:{kind:choice};
    const body=JSON.stringify({expectedControlRevision:context.diagnostic.controlRevision,expectedOwnerRevision:context.ownerRevision,target});
    if(intent.current?.body!==body)intent.current={body,key:crypto.randomUUID()};
    try{const value=await client.request(`/v1/attendance/conversations/${encodeURIComponent(conversationId)}/resume`,{
      method:'POST',headers:{'Idempotency-Key':intent.current.key},body,signal:lifetime.current.signal});
      if(!lifetime.current.signal.aborted)setOperation(ResumeOperationViewSchema.parse(value));
    }catch(reason){if(!lifetime.current.signal.aborted)setError(reason instanceof ApiClientError&&reason.code&&operationError[reason.code]||'Não foi possível confirmar a solicitação. Tente novamente com a mesma escolha para consultar a operação, sem duplicá-la.');}
    finally{lock.current=false;if(!lifetime.current.signal.aborted)setBusy(false);}
  }
  const unavailable=context&&['SCOPE_CHANGED','OWNER_CHANGED','REMOTE_RECONCILE','REMOTE_INITIALIZING'].includes(context.diagnostic.reason);
  return <section className="flows-alert" role="dialog" aria-modal="true" aria-labelledby="resume-title" tabIndex={-1} ref={panel} onKeyDown={event=>{
    if(event.key==='Escape')onClose();
    if(event.key==='Tab'){const controls=panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)');if(controls?.length){const first=controls[0]!,last=controls[controls.length-1]!;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}}>
    <h2 id="resume-title">Retomar bot</h2><p>Somente a conversa selecionada será retomada após a confirmação. Conclua o atendimento humano e escolha como o bot deve voltar.</p><p>Vincular ou publicar um fluxo não retoma uma conversa em atendimento humano.</p>{context?<><AttendanceDiagnosticNotice diagnostic={context.diagnostic}/>
      {!context.hasActiveSession?<p>Esta conversa não possui uma sessão do bot. Inicie uma nova sessão com a automação publicada.</p>:null}
      {!context.hasCompatibleCursor?<p>A continuação não está disponível porque não há uma espera compatível pela próxima mensagem.</p>:null}
      {!operation?<><fieldset disabled={busy||Boolean(unavailable)}><legend>Como o bot deve voltar?</legend>
        <label><input type="radio" name="resume-target" aria-describedby="resume-continue-help" disabled={!context.hasCompatibleCursor} checked={choice==='CONTINUE'} onChange={()=>setChoice('CONTINUE')}/>Continuar de onde parou</label><p id="resume-continue-help">Continua a espera compatível pela próxima mensagem.</p>
        <label><input type="radio" name="resume-target" aria-describedby="resume-menu-help" disabled={!context.hasActiveSession||!context.menuNodes.length} checked={choice==='MENU'} onChange={()=>setChoice('MENU')}/>Voltar ao menu</label><p id="resume-menu-help">Volta ao menu escolhido da sessão atual.</p>
        {choice==='MENU'?<label>Menu<select value={menu} onChange={event=>setMenu(event.target.value)}><option value="">Selecione</option>{context.menuNodes.map(node=><option key={node.id} value={node.id}>{node.label}</option>)}</select></label>:null}
        <label><input type="radio" name="resume-target" aria-describedby="resume-new-help" checked={choice==='NEW_SESSION'} onChange={()=>setChoice('NEW_SESSION')}/>Nova sessão</label><p id="resume-new-help">Começa pela versão publicada, sem reproduzir mensagens antigas.</p>
      </fieldset><p>A retomada encerra o ciclo anterior. Mensagens antigas não serão reproduzidas.</p>
      <button type="button" disabled={busy||Boolean(unavailable)||!choice||choice==='MENU'&&!menu} onClick={()=>void submit()}>Confirmar retomada</button></>:null}
    </>:<p>Verificando a conversa…</p>}
    {operation?.state==='PENDING'?<p role="status">Retomada pendente. O bot permanece bloqueado até a confirmação.</p>:null}
    {operation?.state==='UNKNOWN'?<p role="alert">O resultado da mudança na central é incerto. O bot permanece bloqueado; confira a operação antes de retomar.</p>:null}
    {operation?.state==='ACTION_REQUIRED'||operation?.state==='CANCELED'?<p role="alert">{operationError[operation.errorCode??'']??'A retomada não foi aplicada. Confira o atendimento na central e a configuração da caixa antes de tentar novamente.'}</p>:null}
    {error?<p role="alert">{error}</p>:null}<button type="button" onClick={onClose}>Fechar</button>
  </section>;
}
