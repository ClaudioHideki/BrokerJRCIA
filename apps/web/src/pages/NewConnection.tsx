import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';

import type { ProviderAccount } from '@jrc/contracts';

import { ApiClientError } from '../api/client.js';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { connectionAccountLabel } from '../broker/labels.js';
import { createConnection, listBaileysProviderAccounts } from '../connections/api.js';
import { useVolatileIntent } from '../connections/use-volatile-intent.js';

export function NewConnectionPage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const navigate = useNavigate();
  const intent = useVolatileIntent(client);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [providerAccountId, setProviderAccountId] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<{ text: string; requestId?: string } | null>(null);
  const tenantGeneration = useRef(0);
  const tenantId = session?.activeOrganization.id ?? '';

  useEffect(() => {
    const generation = ++tenantGeneration.current;
    let active = true;
    setAccounts([]);
    setProviderAccountId('');
    setName('');
    setError(null);
    setLoading(true);
    setSubmitting(false);
    setRetrying(false);
    intent.clear();
    void listBaileysProviderAccounts(client).then((page) => {
      if (!active || generation !== tenantGeneration.current) return;
      setAccounts(page.data);
      if (page.data.length === 1) setProviderAccountId(page.data[0]!.id);
    }).catch((caught: unknown) => {
      if (!active || generation !== tenantGeneration.current) return;
      const apiError = caught instanceof ApiClientError ? caught : null;
      setError({ text: apiError?.message ?? 'Não foi possível carregar as contas JRC.', ...(apiError?.requestId ? { requestId: apiError.requestId } : {}) });
    }).finally(() => {
      if (active && generation === tenantGeneration.current) setLoading(false);
    });
    const unregister = client.registerTenantPurge(() => {
      active = false;
      tenantGeneration.current += 1;
      setAccounts([]);
      setProviderAccountId('');
      setName('');
      setError(null);
      setLoading(true);
      setSubmitting(false);
      setRetrying(false);
      intent.clear();
    });
    return () => {
      active = false;
      if (tenantGeneration.current === generation) tenantGeneration.current += 1;
      unregister();
    };
  }, [client, intent, tenantId, tenantRevision]);

  if (session?.activeOrganization.role === 'VIEWER') return <Navigate replace to="/conexoes" />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !providerAccountId) return;
    const generation = tenantGeneration.current;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createConnection(client, {
        name: name.trim(), providerAccountId,
      }, intent.acquire({ forceNew: !retrying }));
      if (generation !== tenantGeneration.current) return;
      intent.complete();
      setRetrying(false);
      navigate(`/conexoes/${result.instance.id}`, { replace: true });
    } catch (caught) {
      if (generation !== tenantGeneration.current) return;
      const apiError = caught instanceof ApiClientError ? caught : null;
      setError({ text: apiError?.message ?? 'Não foi possível criar a conexão.', ...(apiError?.requestId ? { requestId: apiError.requestId } : {}) });
      setRetrying(true);
    } finally {
      if (generation === tenantGeneration.current) setSubmitting(false);
    }
  }

  const resetIntent = () => { intent.clear(); setRetrying(false); };
  return (
    <section className="form-page" aria-labelledby="new-connection-title">
      <Link className="back-link" to="/conexoes">← Voltar para conexões</Link>
      <p className="eyebrow">Nova conexão</p>
      <h1 id="new-connection-title">Conectar um WhatsApp</h1>
      <p>Crie sua conexão JRC e leia o QR Code no WhatsApp Business do celular.</p>
      {loading ? <div className="state-card" aria-busy="true">Carregando contas JRC…</div> : null}
      {!loading && accounts.length === 0 ? <div className="notice">Nenhuma conta JRC disponível</div> : null}
      {error ? <div className="notice notice--error" role="alert">{error.text}{error.requestId ? <small>Solicitação: {error.requestId}</small> : null}</div> : null}
      <form className="panel form-grid" onSubmit={(event) => void submit(event)}>
        <label htmlFor="connection-name">Nome da conexão</label>
        <input id="connection-name" maxLength={120} required value={name} onChange={(event) => { setName(event.target.value); resetIntent(); }} />
        <label htmlFor="provider-account">Conta JRC</label>
        <select id="provider-account" required value={providerAccountId} onChange={(event) => { setProviderAccountId(event.target.value); resetIntent(); }}>
          <option value="">Selecione</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{connectionAccountLabel(account.name)}</option>)}
        </select>
        <button className="button button--primary" type="submit" disabled={submitting || accounts.length === 0 || !name.trim()}>
          {submitting ? 'Criando…' : retrying ? 'Tentar criação novamente' : 'Criar conexão'}
        </button>
      </form>
    </section>
  );
}
