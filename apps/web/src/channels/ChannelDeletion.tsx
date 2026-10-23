import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { IntegrationRequest } from '../integrations/ChatwootPanel.js';
import { ApiClientError } from '../api/client.js';

type Preview = { resourceId: string; resourceName: string; kind: 'CHANNEL'; canDelete: boolean;
  blockers: string[]; counts: Record<string, number>; externalEffects: string[]; operationId: string | null; operationStatus: Status | null };
type Status = 'REQUESTED' | 'BLOCKING' | 'CLEANING_EXTERNAL' | 'REMOVING_DATA' | 'COMPLETED' | 'ACTION_REQUIRED';
type Operation = { operationId: string; status: Status; errorCode?: string | null };
const statuses: Record<Status, string> = {
  REQUESTED: 'Exclusão solicitada', BLOCKING: 'Bloqueando novas operações', CLEANING_EXTERNAL: 'Removendo a sessão de conexão',
  REMOVING_DATA: 'Removendo dados da conexão', COMPLETED: 'Conexão excluída', ACTION_REQUIRED: 'Exclusão precisa de atenção',
};
const counts: Record<string, string> = { conversations: 'Conversas no Broker', messages: 'Mensagens no Broker',
  automationBindings: 'Vínculos de automação', automations: 'Automações', remoteFlowBots: 'Robôs vinculados na central' };
const deletionReason = 'Exclusão da conexão confirmada pelo administrador no painel do Broker.';
const reconciliationReason = 'Conferência da remoção externa solicitada pelo administrador no painel do Broker.';
const retryableErrors = new Set(['EVOLUTION_INSTANCE_STILL_PRESENT', 'LIFECYCLE_ACTOR_REVOKED', 'LIFECYCLE_PENDING_WORK', 'LIFECYCLE_PURGE_FAILED']);
const errors: Record<string, string> = {
  EVOLUTION_CLEANUP_UNVERIFIED: 'A remoção da sessão WhatsApp ainda não foi confirmada. Confira o resultado externo antes de tentar excluir novamente.',
  EVOLUTION_INSTANCE_STILL_PRESENT:'A consulta confirmou que a sessão ainda existe. Confira o nome e confirme uma nova tentativa de exclusão.',
  LIFECYCLE_PENDING_WORK: 'Há operações pendentes ou com resultado incerto. Conclua ou reconcilie essas operações antes de continuar.',
  LIFECYCLE_PURGE_FAILED: 'A remoção dos dados não foi concluída. A equipe JRC precisa verificar a operação.',
  LIFECYCLE_ACTOR_REVOKED: 'A permissão de quem solicitou a exclusão foi revogada. Um administrador autorizado precisa solicitar novamente.',
  MEDIA_PRIVATE_CLEANUP_UNVERIFIED: 'A remoção dos anexos não foi confirmada. A equipe JRC precisa conferir os arquivos antes de continuar.',
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
  request: IntegrationRequest; path: string; disabled?: boolean; onCompleted?: () => void; scopeKey?: string;
};
export function ChannelDeletion(props: Props) { return <ChannelDeletionOperation key={`${props.scopeKey ?? ''}:${props.path}`} {...props} />; }
function ChannelDeletionOperation({ request, path, disabled = false, onCompleted }: Props) {
  const api = useRef(request); api.current = request;
  const callback = useRef(onCompleted); callback.current = onCompleted;
  const live = useRef(false), pending = useRef(false), completed = useRef(false), readRevision = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null), [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false), [outcomeRead, setOutcomeRead] = useState(false), [pollVersion, setPollVersion] = useState(0);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; readRevision.current++; }; }, []);
  function acceptOperation(result: Operation, verified: boolean) {
    setOperation(result); setOutcomeRead(verified);
    if (result.status === 'COMPLETED' && !completed.current) { completed.current = true; callback.current?.(); }
  }
  async function inspect() {
    if (pending.current || disabled) return;
    pending.current = true; readRevision.current++; setBusy(true); setError('');
    try {
      const result = parsePreview(await api.current(`${path}/deletion-preview`), path.split('/').at(-1)!);
      if (live.current) {
        setPreview(result);
        if (result.operationId && result.operationStatus) {
          acceptOperation({ operationId: result.operationId, status: result.operationStatus }, false);
          setUnconfirmed(false); setPollVersion(value => value + 1);
        } else if (unconfirmed) setError('A solicitação anterior ainda não foi confirmada. Continue consultando o andamento; não envie outra exclusão.');
      }
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
      acceptOperation(result, true); setUnconfirmed(false); setError('');
    } catch { if (live.current && current === readRevision.current) setError('Não foi possível consultar a exclusão. A solicitação pode continuar no servidor; atualize o andamento.'); }
  }
  const active = operation && !['COMPLETED', 'ACTION_REQUIRED'].includes(operation.status);
  const canRequest = !operation || operation.status === 'ACTION_REQUIRED';
  const canSubmit = !busy && !disabled && !unconfirmed && Boolean(preview?.canDelete) && !preview?.blockers.length
    && canRequest && (!operation || (outcomeRead && retryableErrors.has(operation.errorCode ?? '')));
  useEffect(() => {
    if (!operation||operation.status==='COMPLETED') return;
    void refresh();
    if(!active)return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [operation?.operationId, operation?.status, pollVersion]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !canSubmit || !preview) return;
    pending.current = true;readRevision.current++; setBusy(true); setError('');
    try {
      const result = parseOperation(await api.current(`${path}/deletion`, 'POST', { confirmationName: preview.resourceName, reason: deletionReason }));
      if (live.current) { acceptOperation(result, false); setUnconfirmed(false); setPollVersion(value => value + 1); }
    } catch (caught) {
      if (live.current) {
        if (caught instanceof ApiClientError && [400, 403, 404, 409, 429].includes(caught.status)) {
          setPreview(null); setUnconfirmed(false); setError('O servidor recusou a exclusão. Confira novamente o impacto e as pendências antes de confirmar.');
        } else {
          setUnconfirmed(true); setError('A solicitação não foi confirmada. Consulte o andamento; uma resposta perdida não autoriza repetir a exclusão.');
        }
      }
    }
    finally { pending.current = false; if (live.current) setBusy(false); }
  }
  async function reconcile(){
    if(pending.current||disabled||unconfirmed||!outcomeRead||!operation||operation.status!=='ACTION_REQUIRED'||operation.errorCode!=='EVOLUTION_CLEANUP_UNVERIFIED')return;
    pending.current=true;readRevision.current++;setBusy(true);setError('');
    try{const result=parseOperation(await api.current(`${path}/deletion/${operation.operationId}/reconcile`,'POST',{reason:reconciliationReason}));
      if(live.current){acceptOperation(result,false);setUnconfirmed(false);setPollVersion(value=>value+1);}
    }catch{if(live.current){setUnconfirmed(true);setError('A conferência não foi confirmada. Atualize o andamento antes de tentar novamente.');}}
    finally{pending.current=false;if(live.current)setBusy(false);}
  }
  return <div className="channel-deletion">
    {!preview && !operation && <button className="button button--danger" disabled={disabled || busy} onClick={() => void inspect()}>Excluir conexão</button>}
    {error && <p className="notice notice--error" role="alert">{error}</p>}
    {preview && canRequest && <section className="panel" aria-label="Exclusão definitiva da conexão">
      <h3>Excluir definitivamente {preview.resourceName}</h3>
      <p>A conexão, suas conversas, mensagens, mídias e configurações exclusivas no Broker serão removidas. As caixas, contas e conversas no JRC Conversas/Chatwoot e os ativos empresariais na Meta são preservados.</p>
      <dl>{Object.entries(preview.counts).map(([key, value]) => <div key={key}><dt>{counts[key] ?? 'Registros vinculados'}</dt><dd>{value}</dd></div>)}</dl>
      {preview.externalEffects.length > 0 && <ul>{preview.externalEffects.map(effect => <li key={effect}>{effect}</li>)}</ul>}
      {preview.blockers.map(blocker => <p className="notice" key={blocker}>{blocker === 'PENDING_OR_UNCERTAIN_WORK'
        ? 'Há entregas/operações em andamento ou incertas. Reconcilie antes da exclusão.' : blocker === 'FLOW_REMOTE_BOT_ATTACHED'
        ? 'Há um robô Flow vinculado a uma caixa. Abra JRC Flows → selecione o Flow → Conexões e desative o vínculo. Confirme a remoção em JRC Conversas/Chatwoot → Configurações → Caixas de entrada → Configuração do Bot antes de consultar o impacto novamente.'
        : 'Existe uma pendência que impede a exclusão. Peça à equipe JRC para conferir.'}</p>)}
      <form className="form-grid" onSubmit={event => void submit(event)}>
        <div className="button-row"><button className="button button--danger" disabled={!canSubmit}>{operation ? 'Retentar exclusão segura' : 'Confirmar exclusão definitiva'}</button>
          {!unconfirmed && <button type="button" className="button button--secondary" disabled={busy} onClick={() => setPreview(null)}>Cancelar</button>}</div>
      </form>
    </section>}
    {unconfirmed && !operation && <button className="button button--secondary" disabled={busy || disabled} onClick={() => void inspect()}>Conferir solicitação</button>}
    {operation && <section className="notice" aria-live="polite"><strong>{statuses[operation.status]}</strong>
      <p>Operação: {operation.operationId}</p>
      {operation.status === 'ACTION_REQUIRED' && <p>{errors[operation.errorCode ?? ''] ?? 'A exclusão não foi concluída. Peça à equipe JRC para conferir a operação antes de continuar.'}</p>}
      {operation.status==='ACTION_REQUIRED'&&operation.errorCode==='EVOLUTION_CLEANUP_UNVERIFIED'&&<div><p>Esta consulta confere a sessão no provedor e não repete a exclusão.</p>
        <button className="button button--secondary" disabled={busy||disabled||unconfirmed||!outcomeRead} onClick={()=>void reconcile()}>Conferir remoção externa</button></div>}
      {operation.status !== 'COMPLETED' && <button className="button button--secondary" onClick={() => void refresh()}>Atualizar exclusão</button>}
      {operation.status === 'ACTION_REQUIRED' && <button className="button button--secondary" disabled={busy || disabled} onClick={() => void inspect()}>Conferir pendências</button>}
    </section>}
  </div>;
}
