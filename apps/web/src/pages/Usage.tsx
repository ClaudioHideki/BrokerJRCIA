import { useLayoutEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { PageHeading, Metric, number } from '../broker/components.js';
import { Icon } from '../broker/Icon.js';
type Limits = {
  status: string;
  maxInstances: number;
  maxUsers: number;
  messagesPerDay: number;
  maxPendingMessages: number;
  messagesAcceptedToday: number;
};
export function UsagePage() {
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const [data, setData] = useState<Limits | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useLayoutEffect(() => {
    const abort = new AbortController();
    setData(null);
    setError('');
    const unregister = client.registerTenantPurge(() => {
      abort.abort();
      setData(null);
      setError('');
    });
    void client
      .request<Limits>('/v1/organization/operations', { signal: abort.signal })
      .then((d) => {
        if (abort.signal.aborted) return;
        if (
          !d ||
          ![
            'maxInstances',
            'maxUsers',
            'messagesPerDay',
            'maxPendingMessages',
            'messagesAcceptedToday',
          ].every(
            (k) => Number.isSafeInteger(d[k as keyof Limits]) && Number(d[k as keyof Limits]) >= 0,
          )
        )
          throw new Error('Invalid limits');
        setData(d);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('Não foi possível consultar o consumo.');
      });
    return () => {
      abort.abort();
      unregister();
    };
  }, [client, session?.activeOrganization.id, tenantRevision, revision]);
  return (
    <section>
      <PageHeading
        title="Uso e custos"
        description="Acompanhe o consumo e os limites da sua empresa."
      >
        <button className="button button--ghost" onClick={() => setRevision((v) => v + 1)}>
          <Icon name="refresh" />
          Atualizar
        </button>
      </PageHeading>
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p role="status">Consultando consumo…</p>
      ) : null}
      {data ? (
        <>
          <div className="metric-grid metric-grid--four">
            <Metric
              label="Saídas aceitas hoje"
              value={number(data.messagesAcceptedToday)}
              note="Dia corrente em UTC"
              icon="messages"
            />
            <Metric
              label="Limite diário"
              value={number(data.messagesPerDay)}
              note="Mensagens por dia"
              icon="reports"
            />
            <Metric
              label="Limite de conexões"
              value={number(data.maxInstances)}
              note="Configurado para a empresa"
              icon="connections"
            />
            <Metric
              label="Custo consolidado"
              value="—"
              note="Faturamento ainda não integrado"
              tone="purple"
              icon="costs"
            />
          </div>
          <div className="dashboard-middle">
            <section className="panel">
              <h2>Consumo diário de mensagens</h2>
              <div className="quota-value">
                <strong>{number(data.messagesAcceptedToday)}</strong>
                <span> / {number(data.messagesPerDay)} mensagens</span>
              </div>
              <progress
                max={Math.max(data.messagesPerDay, 1)}
                value={Math.min(data.messagesAcceptedToday, Math.max(data.messagesPerDay, 1))}
                aria-label="Consumo diário"
              />
              <p>Quota aplicada pelo servidor · Reinício do período em UTC</p>
              <dl className="quota-details">
                <div>
                  <dt>Usuários permitidos</dt>
                  <dd>{data.maxUsers}</dd>
                </div>
                <div>
                  <dt>Limite de pendências</dt>
                  <dd>{number(data.maxPendingMessages)}</dd>
                </div>
                <div>
                  <dt>Estado da empresa</dt>
                  <dd>{data.status === 'ACTIVE' ? 'Ativa' : 'Operação suspensa'}</dd>
                </div>
              </dl>
            </section>
            <section className="panel billing-empty">
              <span className="quick-icon">
                <Icon name="costs" size={26} />
              </span>
              <h2>Uma visão financeira confiável</h2>
              <p>
                Custos por provedor, tarifas Meta, IA e cobranças JRC exigem um registro de consumo
                e conciliação financeira. Os valores serão exibidos quando essa integração estiver
                disponível.
              </p>
              <Link to="/relatorios">Consultar volume de mensagens →</Link>
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}
