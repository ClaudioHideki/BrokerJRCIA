import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { jrcCssVariables, jrcDarkCssVariables } from '@jrc/ui';
import { useApiClient } from '../auth/SessionProvider.js';
import { healthDestination, healthGroups, healthGroup, healthGuidance, healthLabels, healthTitle } from '../operations/health-model.js';
import { useOperationalHealth } from '../operations/useOperationalHealth.js';
import '../operations/health.css';

const units: Record<string, string> = { seconds: 'segundos', channels: 'caixas', destinations: 'destinos', items: 'itens', executions: 'execuções' };
const formatDate = (value: string) => new Date(value).toLocaleString('pt-BR');

export function OperationalHealthPage() {
  const client = useApiClient();
  const { data, loading, failed, refresh } = useOperationalHealth(client);
  const [dark, setDark] = useState(false);
  return <section className="ops-health" aria-label="Saúde operacional" data-theme={dark ? 'dark' : 'light'} style={{ ...jrcCssVariables, ...(dark ? jrcDarkCssVariables : {}) } as CSSProperties}>
    <header className="ops-heading">
      <div><p className="ops-eyebrow">OPERAÇÃO / DIAGNÓSTICO</p><h1>Saúde operacional</h1><p>Entenda os sinais da plataforma e o que precisa de atenção.</p></div>
      <div className="ops-actions"><button type="button" aria-pressed={dark} onClick={() => setDark(!dark)}>Tema escuro nesta área</button><button type="button" disabled={loading} onClick={refresh}>{loading ? 'Consultando…' : 'Atualizar'}</button></div>
    </header>
    <p className="ops-caption">Empresa ativa no menu superior · atualização a cada 30 segundos · somente consulta</p>
    {failed ? <p role="alert" className="ops-notice ops-state--down">{data ? 'Dados desatualizados: não foi possível atualizar. Abaixo está a última consulta bem-sucedida; ela não confirma o estado atual.' : 'Não foi possível consultar a saúde operacional. Tente atualizar novamente.'}</p> : null}
    <div role="status" className="ops-caption">{loading ? data ? 'Atualizando a consulta…' : 'Consultando componentes…' : data ? 'Consulta concluída.' : ''}</div>
    {data ? <>
      <div className={`ops-summary ops-state--${failed ? 'unknown' : data.overall.toLowerCase()}`}>
        <div><span className="ops-eyebrow">{failed ? 'ÚLTIMO RETRATO DISPONÍVEL' : 'RESUMO REPORTADO PELA API'}</span><h2>{failed ? 'Verificação desatualizada' : healthLabels[data.overall]}</h2><p>O resumo inclui pendências acumuladas e componentes ainda não verificados.</p></div>
        <div><strong>{data.alerts.length} alertas reportados</strong><p>Observado em <time dateTime={data.observedAt}>{formatDate(data.observedAt)}</time></p></div>
      </div>
      {!data.components.length ? <p className="ops-notice">Nenhum componente informado pela API nesta consulta.</p> : healthGroups.map(group => {
        const components = data.components.filter(item => healthGroup(item.key) === group.id);
        return components.length ? <section key={group.id} aria-labelledby={`ops-${group.id}`} className="ops-group">
          <h2 id={`ops-${group.id}`}>{group.title}</h2><p className="ops-description">{group.description}</p>
          <div className="ops-grid">{components.map(item => {
            const destination = healthDestination(item.key);
            return <article key={item.key} className="ops-card">
              <header><h3>{healthTitle(item.key, item.label)}</h3><span className={`ops-badge ops-state--${item.state.toLowerCase()}`}>{healthLabels[item.state]}</span></header>
              {item.metric !== undefined ? <p className="ops-metric">{item.metric.toLocaleString('pt-BR')} <span>{units[item.unit ?? ''] ?? item.unit ?? 'registros'}</span></p> : null}
              {item.unit === 'seconds' && item.metric !== undefined && item.metric < 0 ? <p>Horário do registro à frente da consulta. Verifique a sincronização dos relógios.</p> : null}
              <p>{healthGuidance(item.key, item.code)}</p>
              {destination ? <Link to={destination.to}>{destination.label}<span className="ops-sr-only">: {healthTitle(item.key, item.label)}</span> →</Link> : null}
              <details><summary>Detalhes técnicos</summary><code>{item.code}</code><p>{item.observedAt ? `Observação: ${formatDate(item.observedAt)}` : 'Sem horário de observação informado.'}</p></details>
            </article>;
          })}</div>
        </section> : null;
      })}
      <section className="ops-group" aria-labelledby="ops-alerts"><h2 id="ops-alerts">Alertas reportados</h2>
        {data.alerts.length ? <ul className="ops-alert-list">{data.alerts.map((item, index) => {
          const destination = healthDestination(item.component);
          return <li key={`${item.component}:${item.code}:${index}`}><div><strong>{healthTitle(item.component, data.components.find(component => component.key === item.component)?.label)}</strong><span className={`ops-badge ops-state--${item.state.toLowerCase()}`}>{healthLabels[item.state]}</span><p>{healthGuidance(item.component, item.code)}</p><code>{item.code}</code></div>{destination ? <Link to={destination.to}>{destination.label} →</Link> : <span>Conferir processo e logs por correlação.</span>}</li>;
        })}</ul> : <p>Nenhum alerta reportado nesta consulta.</p>}
      </section>
    </> : null}
  </section>;
}
