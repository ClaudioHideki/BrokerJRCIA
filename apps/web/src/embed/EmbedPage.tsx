import './embed.css';
import { useEmbedSession } from './useEmbedSession.js';
import { ChallengePanel } from '../connections/components/ChallengePanel.js';

const notices = {
  IDLE: 'Entre no Broker para autorizar este painel.', STARTING: 'Preparando autorização…',
  WAITING: 'Conclua o login e a autorização na janela do portal. A solicitação expira em dois minutos.',
  AUTHORIZED: 'Acesso temporário autorizado.', EXPIRED: 'Seu acesso temporário expirou. Autorize novamente para continuar.',
  DENIED: 'Acesso indisponível para esta conta ou caixa. Confira suas permissões no portal.',
  UNAVAILABLE: 'Não foi possível acessar o painel. Tente novamente ou use o portal JRC.',
};

export function EmbedPage() {
  const embedId = /^\/embed\/chatwoot\/([0-9a-f-]{36})$/iu.exec(window.location.pathname)?.[1] ?? '';
  const { state, client, begin, ready, approvalLink, popupBlocked } = useEmbedSession(embedId);
  const active = state.status === 'AUTHORIZED' && state.expiresAt > Date.now();
  return <main className="jrc-embed">
    <header><img src="/brand/logo-jrc-2024.png" alt="JRC" width="89" height="60" /><span>Conexões</span></header>
    <section className="embed-card" aria-labelledby="embed-title">
      <h1 id="embed-title">Conexões JRC</h1>
      <p>Consulte o estado e reconecte as caixas autorizadas da sua empresa.</p>
      <p role="status">{notices[state.status]}</p>
      {active ? <>
        <label htmlFor="embed-connection">Caixa autorizada</label>
        <select id="embed-connection" value={state.selected} onChange={event => client.select(event.target.value)}>
          {state.connections.map(connection => <option key={connection.integrationId} value={connection.integrationId}>{connection.name} · Caixa {connection.inboxId}</option>)}
        </select>
        {state.health ? <p>WhatsApp: {state.health.instanceStatus === 'CONNECTED' ? 'Conectado' : 'Aguardando conexão'} · Transporte: {state.health.transportStatus === 'OPERATIONAL' ? 'Operacional' : 'Sem comprovação completa'}</p> : <p>Consultando estado…</p>}
        <div className="embed-actions">
          {state.connections.find(c => c.integrationId === state.selected)?.canPair ? <button className="embed-button" type="button" disabled={state.busy || !state.health?.allowedActions.includes('pair')} onClick={() => void client.pair()}>{state.busy ? 'Solicitando…' : 'Reconectar WhatsApp'}</button> : null}
          <button className="embed-button embed-button--secondary" type="button" onClick={() => client.stop()}>Encerrar acesso ao painel</button>
        </div>
        {state.action ? <ChallengePanel action={state.action} onExpire={client.clearAction} /> : null}
      </> : <button className="embed-button" type="button" disabled={!ready || ['STARTING', 'WAITING'].includes(state.status)} onClick={() => void begin()}>Autorizar acesso no Broker</button>}
      {state.status === 'WAITING' && approvalLink && popupBlocked ? <p role="alert">A janela foi bloqueada. <a href={approvalLink} target="_blank" rel="noopener noreferrer">Abrir autorização no portal</a></p> : null}
      <p>A primeira conexão e a confirmação do número são feitas no portal da sua empresa.</p>
      <a href="/conexoes" target="_blank" rel="noopener noreferrer">Abrir portal JRC</a>
    </section>
  </main>;
}
