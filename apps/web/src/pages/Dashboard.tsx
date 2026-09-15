import { useState } from "react";
import { Link } from "react-router";
import { useOverview } from "../broker/use-overview.js";
import {
  PageHeading,
  ConnectionMetrics,
  Metric,
  Chart,
  ConnectionDonut,
  DataState,
  Period,
  number,
} from "../broker/components.js";
import { Icon } from "../broker/Icon.js";
export function DashboardPage() {
  const [days, setDays] = useState(30);
  const { data, error, loading, refresh } = useOverview(days);
  return (
    <section>
      <PageHeading
        title="Visão geral"
        description="Toda a sua operação WhatsApp, em um só lugar."
      >
        <Period days={days} setDays={setDays} />
        <button
          className="button button--ghost icon-button"
          onClick={refresh}
          aria-label="Atualizar indicadores"
          disabled={loading}
        >
          <Icon name="refresh" />
        </button>
      </PageHeading>
      <DataState loading={loading} error={error} refresh={refresh} />
      {data ? (
        <>
          <ConnectionMetrics data={data} />
          <div className="dashboard-middle">
            <section className="panel">
              <div className="panel-heading">
                <h2>Volume de mensagens</h2>
                <span className="subtle-tag">{days} dias</span>
              </div>
              <Chart data={data} />
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>Status das conexões</h2>
                <Icon name="info" />
              </div>
              <ConnectionDonut data={data} />
              <p className="chart-footnote">
                Estado atual registrado · Prontidão Meta não comprova entrega.
              </p>
            </section>
          </div>
          <div className="metric-grid metric-grid--four">
            <Metric
              label="Mensagens recebidas"
              value={number(data.messages.incoming)}
              note="Entradas persistidas"
              icon="messages"
              tone="green"
            />
            <Metric
              label="Saídas aceitas"
              value={number(data.messages.outgoing)}
              note="Solicitações registradas na JRC"
              icon="upload"
            />
            <Metric
              label="Entrega confirmada"
              value={number(data.messages.delivered)}
              note="Inclui mensagens lidas"
              icon="check"
              tone="purple"
            />
            <Metric
              label="Resultado incerto"
              value={number(data.messages.unknown)}
              note="Requer conciliação"
              icon="health"
              tone="amber"
            />
          </div>
          <div className="dashboard-bottom">
            <section className="panel">
              <div className="panel-heading">
                <h2>Seus canais JRC</h2>
                <Link to="/providers">
                  Ver canais <Icon name="arrow" size={14} />
                </Link>
              </div>
              {data.providers.map((p) => (
                <div className="provider-row" key={p.provider}>
                  <span className={"provider-mark " + "jrc"}>
                    <Icon
                      name={p.provider === "META" ? "globe" : "connections"}
                    />
                  </span>
                  <div>
                    <strong>
                      {p.provider === "META"
                        ? "WhatsApp Oficial"
                        : "WhatsApp Business"}
                    </strong>
                    <small>
                      {p.provider === "META"
                        ? "Autorização da Meta"
                        : "Conexão por QR Code"}
                    </small>
                  </div>
                  <div className="provider-row-count">
                    <strong>{number(p.total)}</strong>
                    <small>canais</small>
                  </div>
                  <span className="status status--success">
                    {p.online} prontas
                  </span>
                </div>
              ))}
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>Próximos passos</h2>
                <span className="subtle-tag">Sua operação</span>
              </div>
              <Link className="quick-action" to="/conexoes">
                <span className="quick-icon">
                  <Icon name="connections" />
                </span>
                <div>
                  <strong>Gerenciar conexões</strong>
                  <small>Consulte sessões, QR e configurações</small>
                </div>
                <Icon name="arrow" />
              </Link>
              <Link className="quick-action" to="/health">
                <span className="quick-icon amber">
                  <Icon name="health" />
                </span>
                <div>
                  <strong>
                    {data.incidents.length
                      ? data.incidents.length + " operações para revisar"
                      : "Consultar saúde operacional"}
                  </strong>
                  <small>Falhas e resultados que pedem atenção</small>
                </div>
                <Icon name="arrow" />
              </Link>
              <Link className="quick-action" to="/mensagens">
                <span className="quick-icon">
                  <Icon name="messages" />
                </span>
                <div>
                  <strong>Mensagens e automações</strong>
                  <small>Templates, histórico e Typebot</small>
                </div>
                <Icon name="arrow" />
              </Link>
            </section>
          </div>
          <p className="page-footnote">
            <i className="dot mint" />
            Consulta: {new Date(data.observedAt).toLocaleString("pt-BR")} ·
            Empresa ativa · Período UTC
          </p>
        </>
      ) : null}
    </section>
  );
}
