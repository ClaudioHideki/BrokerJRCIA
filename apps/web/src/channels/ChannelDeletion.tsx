import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { IntegrationRequest } from '../integrations/ChatwootPanel.js';

type Preview = { resourceId: string; resourceName: string; kind: 'CHANNEL'; canDelete: boolean;
  blockers: string[]; counts: Record<string, number>; externalEffects: string[]; operationId: string | null; operationStatus: Status | null };
type Status = 'REQUESTED' | 'BLOCKING' | 'CLEANING_EXTERNAL' | 'REMOVING_DATA' | 'COMPLETED' | 'ACTION_REQUIRED';
type Operation = { operationId: string; status: Status; errorCode?: string | null };
const statuses: Record<Status, string> = {
  REQUESTED: 'Exclusão solicitada', BLOCKING: 'Bloqueando novas operações', CLEANING_EXTERNAL: 'Removendo a sessão de conexão',
  REMOVING_DATA: 'Removendo dados da conexão', COMPLETED: 'Conexão excluída', ACTION_REQUIRED: 'Exclusão precisa de atenção',
};
const counts: Record<string, string> = { conversations: 'Conversas no Broker', messages: 'Mensagens no Broker',
  automationBindings: 'Vínculos de automação', automations: 'Automações' };
const errors: Record<string, string> = {
  EVOLUTION_CLEANUP_UNVERIFIED: 'A remoção da sessão WhatsApp ainda não foi confirmada. Confira o resultado externo antes de tentar excluir novamente.',
  EVOLUTION_INSTANCE_STILL_PRESENT:'A consulta confirmou que a sessão ainda existe. Confira o nome e confirme uma nova tentativa de exclusão.',
  LIFECYCLE_PENDING_WORK: 'Há operações pendentes ou com resultado incerto. Conclua ou reconcilie essas operações antes de continuar.',
  LIFECYCLE_PURGE_FAILED: 'A remoção dos dados não foi concluída. A equipe JRC precisa verificar a operação.',
  LIFECYCLE_ACTOR_REVOKED: 'A permissão de quem solicitou a exclusão foi revogada. Um administrador autorizado precisa solicitar novamente.',
};
function parseOperation(raw: unknown): Operation {
  const value = raw as Partial<Operation> | null;
  if (!value || typeof value.operationId !== 'string' || !value.operationId || !value.status || !Object.hasOwn(statuses, value.status)) throw new Error('INVALID_OPERATION');
  return value as Operation;
}
function parsePreview(raw: unknown, resourceId: string): Preview {
  const value = raw as Partial<Preview> | null;
  if (!value || value.resourceId !== resourceId || value.kind !== 'CHANNEL' || typeof value.resourceName !== 'string'
    || typeof value.canDelete !== 'boolean' || !Array.isArray(value.blockers) || !value.blockers.every(item => typeof item === 'string')
    || !value.counts || Object.values(value.counts).some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0)
    || !Array.isArray(value.externalEffects) || !value.externalEffects.every(item => typeof item === 'string')
    || !((value.operationId === null && value.operationStatus === null)
      || (typeof value.operationId === 'string' && value.operationId.length > 0 && value.operationStatus && Object.hasOwn(statuses, value.operationStatus)))) throw new Error('INVALID_PREVIEW');
  return value as Preview;
}

type Props = {
  request: IntegrationRequest; path: string; disabled?: boolean; onCompleted?: () => void;
};
export function ChannelDeletion(props: Props) { return <ChannelDeletionOperation key={props.path} {...props} />; }
function ChannelDeletionOperation({ request, path, disabled = false, onCompleted }: Props) {
  const api = useRef(request); api.current = request;
  const callback = useRef(onCompleted); callback.current = onCompleted;
  const live = useRef(false), pending = useRef(false), completed = useRef(false), readRevision = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null), [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [name, setName] = useState(''), [reason, setReason] = useState('');
  useEffect(() => { live.current = true; return () => { live.current = false; readRevision.current++; }; }, []);
  async function inspect() {
    if (pending.current || disabled) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = parsePreview(await api.current(`${path}/deletion-preview`), path.split('/').at(-1)!);
      if (live.current) { setPreview(result); setName(''); setReason('');
        if (result.operationId && result.operationStatus) setOperation({ operationId: result.operationId, status: result.operationStatus }); }
    } catch { if (live.current) setError('Não foi possível conferir o impacto da exclusão. Atualize e tente novamente.'); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  }
  async function refresh() {
    if (!operation||pending.current) return;
    const current = ++readRevision.current;
    try {
      const result = parseOperation(await api.current(`${path}/deletion/${encodeURIComponent(operation.operationId)}`));
      if (result.operationId !== operation.operationId) throw new Error('OPERATION_MISMATCH');
      if (!live.current || current !== readRevision.current) return;
      setOperation(result); setError('');
      if (result.status === 'COMPLETED' && !completed.current) { completed.current = true; callback.current?.(); }
    } catch { if (live.current && current === readRevision.current) setError('Não foi possível consultar a exclusão. A solicitação pode continuar no servidor; atualize o andamento.'); }
  }
  const active = operation && !['COMPLETED', 'ACTION_REQUIRED'].includes(operation.status);
  const canRequest = !operation || operation.status === 'ACTION_REQUIRED';
  useEffect(() => {
    if (!operation||operation.status==='COMPLETED') return;
    void refresh();
    if(!active)return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [operation?.operationId, operation?.status]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || disabled || operation?.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED' || !preview?.canDelete || preview.blockers.length || name !== preview.resourceName || reason.trim().length < 5 || !canRequest) return;
    pending.current = true;readRevision.current++; setBusy(true); setError('');
    try {
      const result = parseOperation(await api.current(`${path}/deletion`, 'POST', { confirmationName: name, reason: reason.trim() }));
      if (live.current) setOperation(result);
    } catch { if (live.current) setError('A solicitação não foi confirmada. Consulte a prévia antes de repetir; nenhuma conclusão foi comprovada.'); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  }
  async function reconcile(){
    if(pending.current||disabled||!operation||reason.trim().length<5)return;
    pending.current=true;readRevision.current++;setBusy(true);setError('');
    try{const result=parseOperation(await api.current(`${path}/deletion/${operation.operationId}/reconcile`,'POST',{reason:reason.trim()}));
      if(live.current)setOperation(result);
    }catch{if(live.current)setError('A conferência não foi confirmada. Atualize o andamento antes de tentar novamente.');}
    finally{pending.current=false;if(live.current)setBusy(false);}
  }
  return <div className="channel-deletion">
    {!preview && !operation && <button className="button button--danger" disabled={disabled || busy} onClick={() => void inspect()}>Excluir conexão</button>}
    {error && <p className="notice notice--error" role="alert">{error}</p>}
    {preview && canRequest && <section className="panel" aria-label="Exclusão definitiva da conexão">
      <h3>Excluir definitivamente {preview.resourceName}</h3>
      <p>A conexão e seus dados exclusivos no Broker serão removidos. As caixas, contas e conversas no JRC Conversas/Chatwoot e os ativos empresariais na Meta são preservados.</p>
      <dl>{Object.entries(preview.counts).map(([key, value]) => <div key={key}><dt>{counts[key] ?? 'Registros vinculados'}</dt><dd>{value}</dd></div>)}</dl>
      {preview.externalEffects.length > 0 && <ul>{preview.externalEffects.map(effect => <li key={effect}>{effect}</li>)}</ul>}
      {preview.blockers.map(blocker => <p className="notice" key={blocker}>{blocker === 'PENDING_OR_UNCERTAIN_WORK'
        ? 'Há entregas/operações em andamento ou incertas. Reconcilie antes da exclusão.' : blocker === 'FLOW_REMOTE_BOT_ATTACHED'
        ? 'Há um robô Flow vinculado a uma caixa. Abra JRC Flows → selecione o Flow → Conexões e desative o vínculo. Confirme a remoção em JRC Conversas/Chatwoot → Configurações → Caixas de entrada → Configuração do Bot antes de consultar o impacto novamente.'
        : 'Existe uma pendência que impede a exclusão. Peça à equipe JRC para conferir.'}</p>)}
      <form className="form-grid" onSubmit={event => void submit(event)}>
        <label>Digite o nome da conexão<input value={name} onChange={event => setName(event.target.value)} autoComplete="off" maxLength={160} required /></label>
        <label>Motivo da exclusão<textarea value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={500} required /></label>
        <div className="button-row"><button className="button button--danger" disabled={busy || disabled || operation?.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED' || !preview.canDelete || Boolean(preview.blockers.length) || name !== preview.resourceName || reason.trim().length < 5}>{operation ? 'Retentar exclusão segura' : 'Confirmar exclusão definitiva'}</button>
          <button type="button" className="button button--secondary" disabled={busy} onClick={() => setPreview(null)}>Cancelar</button></div>
      </form>
    </section>}
    {operation && <section className="notice" aria-live="polite"><strong>{statuses[operation.status]}</strong>
      <p>Operação: {operation.operationId}</p>
      {operation.status === 'ACTION_REQUIRED' && <p>{errors[operation.errorCode ?? ''] ?? 'A exclusão não foi concluída. Peça à equipe JRC para conferir a operação antes de continuar.'}</p>}
      {operation.status==='ACTION_REQUIRED'&&operation.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED'&&<div><p>Esta consulta não repete a exclusão. Informe o motivo no formulário.</p>
        <button className="button button--secondary" disabled={busy||disabled||reason.trim().length<5} onClick={()=>void reconcile()}>Conferir remoção externa</button></div>}
      {operation.status !== 'COMPLETED' && <button className="button button--secondary" onClick={() => void refresh()}>Atualizar exclusão</button>}
      {operation.status === 'ACTION_REQUIRED' && <button className="button button--secondary" disabled={busy || disabled} onClick={() => void inspect()}>Conferir pendências</button>}
    </section>}
  </div>;
}
