import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionHealthSchema, ConnectionResponseSchema, OperatorGrantViewSchema, type ConnectionAction, type ConnectionHealth } from '@jrc/contracts';
import { ChallengePanel } from '../connections/components/ChallengePanel.js';
import type { IntegrationRequest } from './ChatwootPanel.js';

function ConnectionControls({ id, request, canManage }: { id: string; request: IntegrationRequest; canManage: boolean }) {
  const api = useRef(request); api.current = request;
  const generation = useRef(0), actionRevision = useRef(0), mutation = useRef(false), live = useRef(false), identityRevision = useRef(0);
  const [health, setHealth] = useState<ConnectionHealth | null>(null), [action, setAction] = useState<ConnectionAction | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [permissions, setPermissions] = useState<ReturnType<typeof OperatorGrantViewSchema.parse> | null>(null);
  const [grants, setGrants] = useState<{ userId: string; canPair: boolean }[]>([]), [notice, setNotice] = useState('');
  const clearAction = useCallback(() => setAction(null), []);
  const refresh = useCallback(async () => {
    const current = generation.current;
    try {
      const next = ConnectionHealthSchema.parse(await api.current(`/control/connections/${id}/status`));
      if (current !== generation.current) return;
      if (next.integrationId !== id) throw new Error('MISMATCH');
      if (identityRevision.current !== next.identityRevision) { setConfirmed(false); identityRevision.current = next.identityRevision; }
      setHealth(next);
      if (!next.allowedActions.includes('pair') || next.instanceStatus === 'CONNECTED') { actionRevision.current++; setAction(null); }
      setError('');
    } catch {
      if (current === generation.current) { generation.current++; setAction(null); setHealth(null); setError('Não foi possível conferir o acesso e o estado. Atualize ou peça ao administrador para revisar suas permissões.'); }
    }
  }, [id]);
  useEffect(() => {
    live.current = true; generation.current++; const current = generation.current;
    void refresh();
    if (canManage) void api.current(`/connections/${id}/operator-grants`).then(raw => {
      if (current !== generation.current) return;
      const parsed = OperatorGrantViewSchema.parse(raw); setPermissions(parsed); setGrants(parsed.grants);
    }).catch(() => { if (current === generation.current) setError('Não foi possível consultar permissões.'); });
    const timer = setInterval(() => void refresh(), 5000);
    const leave = () => { generation.current++; setAction(null); };
    window.addEventListener('pagehide', leave);
    return () => { live.current = false; generation.current++; clearInterval(timer); window.removeEventListener('pagehide', leave); };
  }, [id, canManage, refresh]);
  async function perform(kind: 'pair' | 'confirm-identity' | 'grants') {
    if (mutation.current || !health || (kind === 'pair' ? !health.allowedActions.includes('pair') : !canManage)) return;
    if (kind === 'confirm-identity' && !confirmed) return;
    mutation.current = true; setBusy(true); setAction(null); setError(''); setNotice(''); const current = generation.current, revision = ++actionRevision.current;
    try {
      const response = await api.current(kind === 'grants' ? `/connections/${id}/operator-grants` : `/control/connections/${id}/${kind}`,
        kind === 'grants' ? 'PUT' : 'POST', kind === 'grants' ? { grants } : kind === 'confirm-identity' ? { observedRevision: health.identityRevision } : {}, { idempotencyKey: crypto.randomUUID() });
      if (current !== generation.current) return;
      if (kind === 'pair') {
        if (revision !== actionRevision.current) return;
        const result = ConnectionResponseSchema.parse(response);
        if (result.instance.id !== health.instanceId || ['REDIRECT', 'EMBEDDED_SIGNUP'].includes(result.action.type)) throw new Error('MISMATCH');
        setAction(result.action);
      } else { setNotice(kind === 'grants' ? 'Permissões atualizadas.' : 'Identidade aprovada.'); setConfirmed(false); await refresh(); }
    } catch { if (current === generation.current) { setAction(null); setError('Operação não confirmada. Confira o estado e as permissões antes de continuar.'); } }
    finally { mutation.current = false; if (live.current) setBusy(false); }
  }
  return <div className="form-stack">
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button className="button button--secondary" onClick={() => void refresh()}>Conferir estado</button>
    {health && <>
      <p>Sessão WhatsApp: {health.instanceStatus} · Transporte: {health.transportStatus}</p>
      <p>Identidade: {health.identityStatus}{health.observedNumberSuffix && ` · Final observado: ${health.observedNumberSuffix}`}</p>
      {health.allowedActions.includes('pair') && <button className="button button--primary" disabled={busy} onClick={() => void perform('pair')}>Conectar ou reconectar</button>}
      {canManage && health.identityStatus === 'CONFIRMATION_REQUIRED' && <fieldset disabled={busy}>
        <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Conferi o número e autorizo esta identidade</label>
        <button className="button button--primary" disabled={!confirmed} onClick={() => void perform('confirm-identity')}>Aprovar identidade observada</button>
      </fieldset>}
      {canManage && permissions && <fieldset disabled={busy}><legend>Permissões por usuário do Broker</legend>
        <p>Administradores já gerenciam a empresa. Para acesso restrito, use o papel Leitor e conceda somente as caixas necessárias.</p>
        {permissions.members.filter(member => !['OWNER', 'ADMIN'].includes(member.role)).map(member => {
          const grant = grants.find(g => g.userId === member.userId);
          return <div key={member.userId}>
            <label><input type="checkbox" aria-label={`Acesso de ${member.email}`} checked={Boolean(grant)} onChange={e => setGrants(values => e.target.checked ? [...values, { userId: member.userId, canPair: false }] : values.filter(g => g.userId !== member.userId))} />{member.email} · consultar</label>
            <label><input type="checkbox" aria-label={`Reconexão de ${member.email}`} disabled={!grant} checked={grant?.canPair ?? false} onChange={e => setGrants(values => values.map(g => g.userId === member.userId ? { ...g, canPair: e.target.checked } : g))} />Permitir reconexão</label>
          </div>;
        })}
        <button className="button button--secondary" onClick={() => void perform('grants')}>Salvar permissões</button>
      </fieldset>}
    </>}
    {action && <ChallengePanel action={action} onExpire={clearAction} />}
  </div>;
}
export function ChatwootControlPanel({ request, canManage, connections }: { request: IntegrationRequest; canManage: boolean; connections: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(connections[0]?.id ?? '');
  return <section className="panel"><h3>Controle das conexões</h3>
    <p>Conecte, confira a identidade e autorize usuários sem abrir uma conversa no Chatwoot.</p>
    {canManage && <a href="/conexoes/nova">Criar uma conexão WhatsApp</a>}
    <button className="button button--secondary" onClick={() => setOpen(value => !value)}>{open ? 'Fechar controle de conexões' : 'Abrir controle de conexões'}</button>
    {open && <>
      <label>Caixa para controlar<select value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">Selecione uma caixa</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
      </select></label>
      {connections.some(c => c.id === selected) && <ConnectionControls key={selected} id={selected} request={request} canManage={canManage} />}
    </>}
  </section>;
}
