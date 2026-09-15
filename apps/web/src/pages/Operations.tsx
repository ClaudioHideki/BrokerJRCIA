import { useState } from "react";
import { Link } from "react-router";
import { useOverview } from "../broker/use-overview.js";
import {
  PageHeading,
  Metric,
  Chart,
  ConnectionDonut,
  DataState,
  Period,
  number,
} from "../broker/components.js";
import { downloadCsv } from "../broker/import.js";
import { Icon } from "../broker/Icon.js";
export function HealthPage() {
  const [days, setDays] = useState(7);
  const state = useOverview(days);
  const { data } = state;
  return (
    <section>
      <PageHeading
        title="Health Center"
        description="Acompanhe os sinais de atenção da sua operação."
      >
        <Period days={days} setDays={setDays} />
      </PageHeading>
      <DataState {...state} />
      {data ? (
        <>
          <div className="metric-grid metric-grid--four">
            <Metric
              label="Online / prontas"
              value={number(data.connections.online)}
              note="Estado registrado dos canais"
              tone="green"
              icon="check"
            />
            <Metric
              label="Conexões em atenção"
              value={number(data.connections.attention)}
              note="Erro ou ação necessária"
              tone="amber"
              icon="health"
            />
            <Metric
              label="Envios com falha"
              value={number(data.messages.failed)}
              note="Mensagens criadas no período"
              tone="red"
              icon="messages"
            />
            <Metric
              label="Envios incertos"
              value={number(data.messages.unknown)}
              note="Revisar antes de reenviar"
              tone="purple"
              icon="info"
            />
          </div>
          <div className="dashboard-middle">
            <section className="panel">
              <h2>Sinais da operação</h2>
              <div className="health-signal">
                <Icon name="health" size={38} />
                <div>
                  <h3>
                    {data.connections.attention || data.messages.unknown
                      ? "Há itens para revisar"
                      : "Nenhum alerta nestes indicadores"}
                  </h3>
                  <p>
                    Esta visão consulta registros da JRC. Disponibilidade
                    histórica, latência e sondagem contínua do motor ainda não
                    são medidas aqui.
                  </p>
                  <Link to="/conexoes">Ver conexões →</Link>
                </div>
              </div>
            </section>
            <section className="panel">
              <h2>Conexões por estado</h2>
              <ConnectionDonut data={data} />
            </section>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Operações com falha ou resultado incerto</h2>
              <span className="subtle-tag">Até 10 mais recentes</span>
            </div>
            <p>
              Registros de operação no período; não equivalem a incidentes ainda
              abertos.
            </p>
            {data.incidents.length ? (
              <div className="table-scroll">
                <table className="broker-table">
                  <thead>
                    <tr>
                      <th>Atualização</th>
                      <th>Conexão</th>
                      <th>Resultado</th>
                      <th>Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.incidents.map((i) => (
                      <tr key={i.id}>
                        <td>{new Date(i.updatedAt).toLocaleString("pt-BR")}</td>
                        <td>{i.name}</td>
                        <td>
                          <span
                            className={
                              "status status--" +
                              (i.status === "FAILED" ? "danger" : "warning")
                            }
                          >
                            {i.status === "FAILED" ? "Falhou" : "Incerto"}
                          </span>
                        </td>
                        <td>
                          <Link to={"/conexoes/" + i.instanceId}>
                            Ver detalhes →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-inline">
                <Icon name="check" />
                <strong>
                  Nenhuma operação com falha registrada neste período
                </strong>
              </div>
            )}
          </section>
        </>
      ) : null}
    </section>
  );
}
export function ReportsPage() {
  const [days, setDays] = useState(30);
  const state = useOverview(days);
  const { data } = state;
  return (
    <section>
      <PageHeading
        title="Relatórios e BI"
        description="Entenda o volume e os resultados das mensagens armazenadas."
      >
        <Period days={days} setDays={setDays} />
        <button
          className="button button--primary"
          disabled={!data}
          onClick={() => {
            if (data)
              downloadCsv(
                "jrc-mensagens-" + data.observedAt.slice(0, 10) + ".csv",
                [
                  [
                    "Data UTC",
                    "Recebidas",
                    "Saídas aceitas",
                    "Entrega confirmada",
                    "Falhas",
                    "Incertas",
                  ],
                  ...data.daily.map((d) => [
                    d.date,
                    d.incoming,
                    d.outgoing,
                    d.delivered,
                    d.failed,
                    d.unknown,
                  ]),
                ],
              );
          }}
        >
          <Icon name="upload" size={16} />
          Exportar CSV
        </button>
      </PageHeading>
      <DataState {...state} />
      {data ? (
        <>
          <div className="metric-grid metric-grid--four">
            <Metric
              label="Mensagens no período"
              value={number(data.messages.incoming + data.messages.outgoing)}
              note="Entradas e saídas armazenadas"
              icon="messages"
            />
            <Metric
              label="Saídas aceitas"
              value={number(data.messages.outgoing)}
              note="Aceitação pela JRC"
              icon="upload"
            />
            <Metric
              label="Entrega confirmada"
              value={
                data.messages.outgoing
                  ? ((100 * data.messages.delivered) / data.messages.outgoing)
                      .toFixed(1)
                      .replace(".", ",") + "%"
                  : "—"
              }
              note="Entregues ou lidas / saídas aceitas"
              tone="green"
              icon="check"
            />
            <Metric
              label="Resultado incerto"
              value={number(data.messages.unknown)}
              note="Ainda sem confirmação"
              tone="amber"
              icon="health"
            />
          </div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Evolução do volume</h2>
              <span className="subtle-tag">{days} dias · UTC</span>
            </div>
            <Chart data={data} />
          </section>
          <section className="panel report-method">
            <h2>Como interpretar este relatório</h2>
            <p>
              O período considera a criação da mensagem. O status é o mais
              recente registrado, por isso os resultados podem mudar quando
              chegam confirmações. Dados de conexões por QR Code ainda não
              integradas à mensageria JRC não entram nestes totais.
            </p>
            <p>
              Tempo de resposta, SLA, custos, filas e departamentos dependem de
              eventos e módulos adicionais. O CSV contém os mesmos agregados
              exibidos nesta página.
            </p>
          </section>
        </>
      ) : null}
    </section>
  );
}
export function BrainPage() {
  const state = useOverview(7);
  const { data } = state;
  const [topic, setTopic] = useState("attention");
  return (
    <section>
      <PageHeading
        title="JRC Brain"
        description="Transforme os indicadores da operação em próximos passos."
      >
        <span className="provider-badge planned">Diagnóstico por regras</span>
      </PageHeading>
      <DataState {...state} />
      {data ? (
        <div className="brain-layout">
          <aside className="panel brain-topics">
            <h2>Análises disponíveis</h2>
            {[
              ["attention", "Conexões que precisam de atenção"],
              ["messages", "Resultados dos envios"],
              ["providers", "Preparação dos canais"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={topic === key ? "active" : ""}
                onClick={() => setTopic(key!)}
              >
                <Icon
                  name={
                    key === "messages"
                      ? "messages"
                      : key === "providers"
                        ? "providers"
                        : "health"
                  }
                />
                {label}
              </button>
            ))}
            <p>Últimos 7 dias · Empresa ativa</p>
          </aside>
          <section className="panel brain-answer">
            <div className="brain-avatar">
              <Icon name="brain" size={28} />
            </div>
            <span className="eyebrow">LEITURA OPERACIONAL</span>
            <h2>
              {topic === "attention"
                ? "O que precisa da sua atenção?"
                : topic === "messages"
                  ? "Como estão os envios?"
                  : "Como evoluir suas integrações?"}
            </h2>
            {topic === "attention" ? (
              <>
                <p>
                  <strong>{data.connections.attention}</strong> conexões têm
                  erro ou aguardam uma ação. Há{" "}
                  <strong>{data.connections.disconnected}</strong> conexões
                  desconectadas ou revogadas.
                </p>
                <div className="insight-card">
                  <Icon name="info" />
                  <p>
                    Abra os detalhes para consultar estado, histórico e
                    configurações. Estes indicadores não identificam a causa de
                    uma falha de rede.
                  </p>
                </div>
                <Link className="button button--primary" to="/conexoes">
                  Revisar conexões <Icon name="arrow" />
                </Link>
              </>
            ) : topic === "messages" ? (
              <>
                <p>
                  Das <strong>{number(data.messages.outgoing)}</strong> saídas
                  aceitas, <strong>{number(data.messages.delivered)}</strong>{" "}
                  têm entrega confirmada,{" "}
                  <strong>{number(data.messages.failed)}</strong> falharam e{" "}
                  <strong>{number(data.messages.unknown)}</strong> têm resultado
                  incerto.
                </p>
                <div className="insight-card">
                  <Icon name="info" />
                  <p>
                    Um resultado incerto exige conciliação. Reenviar sem
                    verificar pode duplicar a mensagem.
                  </p>
                </div>
                <Link className="button button--primary" to="/relatorios">
                  Abrir relatório <Icon name="arrow" />
                </Link>
              </>
            ) : (
              <>
                <p>
                  A JRC oferece conexão por QR Code e autorização do WhatsApp
                  Oficial. A caixa de entrada das conexões por QR Code ainda
                  está em desenvolvimento. Confira as pendências de ativação de
                  cada canal.
                </p>
                <Link className="button button--primary" to="/providers">
                  Consultar canais JRC <Icon name="arrow" />
                </Link>
              </>
            )}
            <footer>
              Fonte: resumo operacional consultado em{" "}
              {new Date(data.observedAt).toLocaleString("pt-BR")}. Diagnóstico
              calculado por regras, sem modelo de IA. Assistente generativo e
              planos de ação automáticos estão no roteiro de evolução.
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
