import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { EmbedApprovalViewSchema } from '@jrc/contracts';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { SessionBoot } from '../auth/guards.js';
import { LoginPage } from '../pages/Login.js';
import { OrganizationSelectPage } from '../pages/OrganizationSelect.js';

function ApprovalForm({ requestId }: { requestId: string }) {
  const client = useApiClient();
  const [view, setView] = useState<ReturnType<typeof EmbedApprovalViewSchema.parse> | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [done, setDone] = useState('');
  useEffect(() => {
    let current = true, expiry: ReturnType<typeof setTimeout> | undefined;
    void client.request(`/v1/embed/authorizations/${requestId}`).then(raw => {
      if (!current) return;
      const parsed = EmbedApprovalViewSchema.parse(raw);
      if (parsed.requestId !== requestId || Date.parse(parsed.expiresAt) <= Date.now()) throw new Error('EXPIRED');
      setView(parsed);
      expiry = setTimeout(() => { setView(null); setSelected([]); setError('Solicitação expirada. Inicie novamente no painel do Chatwoot.'); }, Date.parse(parsed.expiresAt) - Date.now());
    }).catch(() => { if (current) setError('Solicitação indisponível para esta empresa ou já encerrada. Confira a empresa selecionada e inicie novamente no painel.'); });
    return () => { current = false; clearTimeout(expiry); };
  }, [client, requestId]);
  async function decide(approve: boolean) {
    if (busy || !view || (approve && !selected.length)) return;
    if (Date.parse(view.expiresAt) <= Date.now()) { setView(null); setError('Solicitação expirada. Inicie novamente no painel.'); return; }
    setBusy(true);
    try {
      await client.request(`/v1/embed/authorizations/${requestId}/${approve ? 'approve' : 'deny'}`, { method: 'POST', body: JSON.stringify(approve ? { integrationIds: selected } : {}) });
      setView(null); setSelected([]);
      setDone(approve ? 'Autorização concedida. Volte ao painel do Chatwoot. Você pode fechar esta janela.' : 'Solicitação negada. Você pode fechar esta janela.');
    } catch { setView(null); setSelected([]); setError('Solicitação indisponível. Sua sessão, empresa ou permissões podem ter mudado.'); }
    finally { setBusy(false); }
  }
  if (done) return <p role="status">{done}</p>;
  if (error) return <p role="alert">{error}</p>;
  if (!view) return <p role="status">Conferindo solicitação…</p>;
  return <>
    <p>Destino: <strong>{view.chatwootOrigin}</strong> · Conta {view.accountId}</p>
    <p>Escolha as caixas que este painel poderá consultar e reconectar por cinco minutos.</p>
    <fieldset disabled={busy}><legend>Caixas autorizadas</legend>
      {view.connections.map(connection => <label key={connection.integrationId} className="embed-grant">
        <input type="checkbox" checked={selected.includes(connection.integrationId)} onChange={event => setSelected(current => event.target.checked ? [...current, connection.integrationId] : current.filter(id => id !== connection.integrationId))} />
        <span>{connection.name} · Caixa {connection.inboxId}<small>{connection.canPair ? 'Consultar estado e reconectar' : 'Consultar estado'}</small></span>
      </label>)}
      {!view.connections.length ? <p>Nenhuma caixa disponível para seu usuário nesta empresa.</p> : null}
    </fieldset>
    <div className="embed-actions">
      <button type="button" className="button button--primary" disabled={busy || !selected.length} onClick={() => void decide(true)}>Autorizar por 5 minutos</button>
      <button type="button" className="button button--secondary" disabled={busy} onClick={() => void decide(false)}>Negar solicitação</button>
    </div>
    <p>A primeira conexão e a confirmação de identidade do número são feitas no portal JRC.</p>
  </>;
}

export function AuthorizePage() {
  const [params] = useSearchParams();
  const { status, session, tenantRevision, switchOrganization, switchPending } = useSession();
  const requestId = params.get('requestId');
  if (window.parent !== window || !requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId) || [...params.keys()].some(key => key !== 'requestId') || params.getAll('requestId').length !== 1)
    return <main className="auth-page"><p role="alert">Abra uma solicitação válida no portal JRC.</p></main>;
  if (status === 'booting') return <SessionBoot />;
  // Reuse the portal's login/session and organization selection on this public request URL.
  if (status === 'selecting') return <OrganizationSelectPage />;
  if (status !== 'authenticated' || !session) return <LoginPage />;
  return <main className="auth-page"><section className="auth-card auth-card--wide">
    <h1>Autorizar painel do Chatwoot</h1>
    <p><strong>{session.user.email}</strong></p>
    <label htmlFor="approval-company">Empresa da autorização</label>
    <select id="approval-company" value={session.activeOrganization.id} disabled={switchPending} onChange={event => void switchOrganization(event.target.value)}>
      {session.organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
    </select>
    {switchPending ? <p role="status">Trocando empresa…</p> : <ApprovalForm key={`${requestId}:${session.activeOrganization.id}:${tenantRevision}`} requestId={requestId} />}
    <a href="/conexoes">Abrir portal JRC</a>
  </section></main>;
}
