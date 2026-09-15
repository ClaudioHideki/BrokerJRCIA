import type { ReactNode } from 'react';
import type { BrokerOverview } from '@jrc/contracts';
import { Icon } from './Icon.js';
export const number = (n: number) => n.toLocaleString('pt-BR');
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">WORKSPACE / OPERAÇÃO</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export function Metric({
  label,
  value,
  note,
  tone = 'blue',
  icon = 'dashboard',
}: {
  label: string;
  value: string;
  note: string;
  tone?: string;
  icon?: string;
}) {
  return (
    <article className={'metric metric--' + tone}>
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon name={icon} />
        </span>
      </div>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
export function ConnectionMetrics({ data }: { data: BrokerOverview }) {
  return (
    <div className="metric-grid">
      <Metric
        label="Conexões"
        value={number(data.connections.total)}
        note="Canais cadastrados"
        icon="connections"
      />
      <Metric
        label="Online / prontas"
        value={number(data.connections.online)}
        note="Estado registrado"
        tone="green"
        icon="check"
      />
      <Metric
        label="Precisam de atenção"
        value={number(data.connections.attention)}
        note="Erro ou ação pendente"
        tone="amber"
        icon="health"
      />
      <Metric
        label="Desconectadas"
        value={number(data.connections.disconnected)}
        note="Inclui acesso revogado"
        tone="red"
        icon="connections"
      />
      <Metric
        label="Em implantação"
        value={number(data.connections.provisioning)}
        note="Criação e conexão"
        tone="purple"
        icon="upload"
      />
    </div>
  );
}
export function Chart({ data }: { data: BrokerOverview }) {
  const max = Math.max(1, ...data.daily.flatMap((d) => [d.incoming, d.outgoing]));
  const width = 620,
    height = 165;
  const step = width / data.daily.length;
  return (
    <div className="volume-chart">
      <div className="chart-legend">
        <span>
          <i className="dot blue" />
          Saídas aceitas
        </span>
        <span>
          <i className="dot mint" />
          Recebidas
        </span>
      </div>
      <svg
        viewBox="0 0 680 222"
        role="img"
        aria-label={
          'Volume diário: ' +
          number(data.messages.outgoing) +
          ' saídas aceitas e ' +
          number(data.messages.incoming) +
          ' entradas no período'
        }
      >
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <line x1="40" x2="662" y1={18 + i * 55} y2={18 + i * 55} stroke="#eef2f6" />
            <text x="30" y={22 + i * 55} textAnchor="end" fill="#7a8799" fontSize="10">
              {Math.round((max * (3 - i)) / 3)}
            </text>
          </g>
        ))}
        {data.daily.map((d, i) => (
          <g key={d.date}>
            <rect
              x={40 + i * step + step * 0.12}
              y={18 + height - (d.outgoing / max) * height}
              width={step * 0.32}
              height={(d.outgoing / max) * height}
              rx="2"
              fill="#3074ed"
            >
              <title>
                {d.date}: {d.outgoing} saídas
              </title>
            </rect>
            <rect
              x={40 + i * step + step * 0.48}
              y={18 + height - (d.incoming / max) * height}
              width={step * 0.32}
              height={(d.incoming / max) * height}
              rx="2"
              fill="#92d7c0"
            >
              <title>
                {d.date}: {d.incoming} entradas
              </title>
            </rect>
            {i % Math.ceil(data.daily.length / 7) === 0 ? (
              <text
                x={40 + i * step + step / 2}
                y="209"
                textAnchor="middle"
                fill="#7a8799"
                fontSize="10"
              >
                {d.date.slice(8)}/{d.date.slice(5, 7)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <p className="chart-footnote">Mensagens armazenadas na JRC · Data de criação em UTC</p>
    </div>
  );
}
export function ConnectionDonut({ data }: { data: BrokerOverview }) {
  const c = data.connections;
  const values = [
    ['Online / prontas', c.online, '#24ad81'],
    ['Atenção', c.attention, '#f5b444'],
    ['Desconectadas', c.disconnected, '#ed7380'],
    ['Em implantação', c.provisioning, '#8c9cce'],
    ['Sem estado', c.unobserved, '#d8dee9'],
  ] as const;
  let offset = 0;
  return (
    <div className="donut-layout">
      <div className="donut">
        <svg
          viewBox="0 0 160 160"
          role="img"
          aria-label={'Distribuição de ' + c.total + ' conexões'}
        >
          <circle cx="80" cy="80" r="63" fill="none" stroke="#edf1f6" strokeWidth="18" />
          {values.map(([label, n, color]) => {
            const length = c.total ? (n / c.total) * 395.84 : 0;
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
                strokeDasharray={length + ' ' + (395.84 - length)}
                strokeDashoffset={-start}
                transform="rotate(-90 80 80)"
              />
            );
          })}
        </svg>
        <div>
          <strong>{number(c.total)}</strong>
          <span>conexões</span>
        </div>
      </div>
      <ul className="donut-legend">
        {values.map(([label, n, color]) => (
          <li key={label}>
            <span>
              <i className="dot" style={{ background: color }} />
              {label}
            </span>
            <strong>{number(n)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
export function DataState({
  loading,
  error,
  refresh,
}: {
  loading: boolean;
  error: string;
  refresh: () => void;
}) {
  return (
    <>
      {loading ? (
        <div className="loading-panels" role="status">
          Atualizando indicadores…
        </div>
      ) : null}
      {error ? (
        <div className="notice notice--error" role="alert">
          {error}{' '}
          <button className="button button--ghost" onClick={refresh}>
            Tentar novamente
          </button>
        </div>
      ) : null}
    </>
  );
}
export function Period({ days, setDays }: { days: number; setDays: (n: number) => void }) {
  return (
    <label className="period-control">
      <span className="sr-only">Período dos indicadores</span>
      <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
        <option value="7">Últimos 7 dias</option>
        <option value="30">Últimos 30 dias</option>
        <option value="90">Últimos 90 dias</option>
      </select>
    </label>
  );
}
