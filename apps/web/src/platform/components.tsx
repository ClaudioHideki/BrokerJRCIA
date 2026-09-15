import { useState } from "react";
import { Link } from "react-router";
import { Icon } from "../broker/Icon.js";
import { Metric, number } from "../broker/components.js";
import { statusLabels, type Company } from "./model.js";

export function Status({ status }: { status: Company["status"] }) {
  return (
    <span className={`admin-status admin-status--${status.toLowerCase()}`}>
      <i />
      {statusLabels[status]}
    </span>
  );
}
export function CompanyMark({ company }: { company: Company }) {
  return (
    <span className="admin-company-mark" aria-hidden="true">
      {company.name
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0])
        .join("")
        .toUpperCase()}
    </span>
  );
}
export function CompanyTable({
  companies,
  disabled,
  open,
  compact = false,
}: {
  companies: Company[];
  disabled: boolean;
  open: (company: Company) => void;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const normalized = search.trim().toLocaleLowerCase("pt-BR");
  const filtered = companies.filter(
    (company) =>
      (status === "ALL" || company.status === status) &&
      `${company.name} ${company.slug} ${company.plan}`
        .toLocaleLowerCase("pt-BR")
        .includes(normalized),
  );
  const visible = compact ? filtered.slice(0, 6) : filtered;
  return (
    <section
      className="panel admin-company-table"
      aria-label="Lista de empresas"
    >
      <div className="admin-panel-heading">
        <div>
          <h2>{compact ? "Empresas recentes" : "Seus clientes"}</h2>
          <p>
            {compact
              ? "Acesso rápido à gestão de cada empresa."
              : "Selecione uma empresa para gerenciar sua operação."}
          </p>
        </div>
        {compact ? (
          <Link className="admin-text-link" to="/jrc/empresas">
            Ver todas <Icon name="arrow" size={15} />
          </Link>
        ) : (
          <span className="admin-count">
            {number(companies.length)} empresas
          </span>
        )}
      </div>
      {!compact && (
        <div className="admin-table-filters">
          <div className="admin-search">
            <Icon name="providers" size={16} />
            <input
              type="search"
              aria-label="Buscar empresa"
              placeholder="Buscar por nome, identificador ou plano…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            aria-label="Filtrar situação das empresas"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="ALL">Todas as situações</option>
            <option value="ACTIVE">Ativas</option>
            <option value="SUSPENDED">Suspensas</option>
            <option value="DISABLED">Desativadas</option>
          </select>
        </div>
      )}
      <div className="admin-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Empresa</th>
              <th>Plano</th>
              <th>Situação</th>
              <th>Limite de conexões</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((company) => (
              <tr key={company.id}>
                <td>
                  <div className="admin-company-cell">
                    <CompanyMark company={company} />
                    <div>
                      <strong>{company.name}</strong>
                      <small>{company.slug}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <span className="admin-plan">{company.plan}</span>
                </td>
                <td>
                  <Status status={company.status} />
                </td>
                <td>
                  {company.limits ? number(company.limits.maxInstances) : "—"}
                </td>
                <td>
                  <button
                    className="button button--ghost admin-open"
                    disabled={disabled}
                    aria-label={`Abrir ${company.name}`}
                    onClick={() => open(company)}
                  >
                    Gerenciar <Icon name="arrow" size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!visible.length && (
        <div className="admin-empty">
          <Icon name="providers" size={28} />
          <h3>
            {companies.length
              ? "Nenhuma empresa encontrada"
              : "Nenhuma empresa cadastrada."}
          </h3>
          <p>
            {companies.length
              ? "Ajuste a busca ou o filtro de situação."
              : "Cadastre a primeira empresa para começar."}
          </p>
        </div>
      )}
      <div className="admin-table-footer">
        <span>
          Mostrando {visible.length} de {companies.length} empresas carregadas
        </span>
        <span>Ordenadas pelas mais recentes</span>
      </div>
      {companies.length === 200 && (
        <p className="notice">
          Exibindo as 200 empresas mais recentes. Os indicadores consideram esta
          lista.
        </p>
      )}
    </section>
  );
}

export function AdminMetrics({ companies }: { companies: Company[] }) {
  return (
    <section
      className="metric-grid metric-grid--four"
      aria-label="Resumo das empresas carregadas"
    >
      <Metric
        label="Empresas cadastradas"
        value={number(companies.length)}
        note="Na consulta atual"
        icon="providers"
      />
      <Metric
        label="Empresas ativas"
        value={number(companies.filter((c) => c.status === "ACTIVE").length)}
        note="Habilitadas para operar"
        tone="green"
        icon="check"
      />
      <Metric
        label="Empresas suspensas"
        value={number(companies.filter((c) => c.status === "SUSPENDED").length)}
        note="Novos envios pausados"
        tone="amber"
        icon="health"
      />
      <Metric
        label="Empresas desativadas"
        value={number(companies.filter((c) => c.status === "DISABLED").length)}
        note="Operação desabilitada"
        tone="red"
        icon="providers"
      />
    </section>
  );
}

export function AdminCharts({ companies }: { companies: Company[] }) {
  const active = companies.filter((c) => c.status === "ACTIVE").length;
  const suspended = companies.filter((c) => c.status === "SUSPENDED").length;
  const disabled = companies.length - active - suspended;
  const values = [
    ["Ativas", active, "#24ad81"],
    ["Suspensas", suspended, "#f5b444"],
    ["Desativadas", disabled, "#ed7380"],
  ] as const;
  let offset = 0;
  const plans = [...new Set(companies.map((c) => c.plan))]
    .map((plan) => ({
      plan,
      count: companies.filter((c) => c.plan === plan).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);
  const withLimits = companies.filter((c) => c.limits);
  const maxConnections = withLimits.reduce(
    (sum, c) => sum + c.limits!.maxInstances,
    0,
  );
  const maxUsers = withLimits.reduce((sum, c) => sum + c.limits!.maxUsers, 0);
  return (
    <div className="admin-charts">
      <section className="panel">
        <div className="admin-panel-heading">
          <div>
            <h2>Situação das empresas</h2>
            <p>Distribuição atual da sua base de clientes.</p>
          </div>
          <Icon name="providers" />
        </div>
        <div className="donut-layout">
          <div className="donut">
            <svg
              viewBox="0 0 160 160"
              role="img"
              aria-label={`Situação das empresas: ${active} ativa, ${suspended} suspensa, ${disabled} desativada`}
            >
              <circle
                cx="80"
                cy="80"
                r="63"
                fill="none"
                stroke="#edf1f6"
                strokeWidth="18"
              />
              {values.map(([label, count, color]) => {
                const length = companies.length
                  ? (count / companies.length) * 395.84
                  : 0;
                const start = offset;
                offset += length;
                return (
                  <circle
                    key={label}
                    cx="80"
                    cy="80"
                    r="63"
                    fill="none"
                    stroke={color}
                    strokeWidth="18"
                    strokeDasharray={`${length} ${395.84 - length}`}
                    strokeDashoffset={-start}
                    transform="rotate(-90 80 80)"
                  />
                );
              })}
            </svg>
            <div>
              <strong>{number(companies.length)}</strong>
              <span>empresas</span>
            </div>
          </div>
          <ul className="donut-legend">
            {values.map(([label, count, color]) => (
              <li key={label}>
                <span>
                  <i className="dot" style={{ background: color }} />
                  {label}
                </span>
                <strong>{number(count)}</strong>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="panel">
        <div className="admin-panel-heading">
          <div>
            <h2>Planos e capacidade</h2>
            <p>Limites configurados para as empresas carregadas.</p>
          </div>
          <Link className="admin-text-link" to="/jrc/planos">
            Gerenciar <Icon name="arrow" size={15} />
          </Link>
        </div>
        <div className="admin-capacity">
          <div>
            <span>
              <Icon name="connections" size={16} /> Conexões permitidas
            </span>
            <strong>{withLimits.length ? number(maxConnections) : "—"}</strong>
          </div>
          <div>
            <span>
              <Icon name="key" size={16} /> Usuários permitidos
            </span>
            <strong>{withLimits.length ? number(maxUsers) : "—"}</strong>
          </div>
        </div>
        <div className="admin-plan-bars">
          {plans.map(({ plan, count }) => (
            <div key={plan}>
              <div>
                <span>{plan}</span>
                <small>
                  {count} {count === 1 ? "empresa" : "empresas"}
                </small>
              </div>
              <div className="admin-bar">
                <span
                  style={{ width: `${(count / companies.length) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <p className="admin-footnote">
          Capacidade contratada, sem medição de uso.
          {withLimits.length < companies.length
            ? ` Limites disponíveis para ${withLimits.length} de ${companies.length} empresas.`
            : ""}
          {plans.length < new Set(companies.map((c) => c.plan)).size
            ? " Exibindo os quatro planos mais frequentes."
            : ""}
        </p>
      </section>
    </div>
  );
}
