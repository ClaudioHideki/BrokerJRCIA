import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { GuidedSetup } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { getChannelAutomation } from '../channels/api.js';
import { setupError } from './useGuidedSetup.js';

export function SetupReview({ client, row, busy, action }: { client: ApiClient; row: GuidedSetup; busy: boolean;
  action(name: string, input?: Record<string, unknown>): unknown }) {
  const [keyword, setKeyword] = useState(`teste-${row.id.slice(0, 8)}`), [replace, setReplace] = useState(false);
  const [stopping, setStopping] = useState(false), [error, setError] = useState(''), generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [client, row.organizationId, row.id]);
  async function stop() {
    if (busy || stopping || !row.selection.channelId) return;
    const current = generation.current; setStopping(true); setError('');
    try {
      const owner = await getChannelAutomation(client, row.selection.channelId);
      if (current === generation.current) await action('deactivate', { expectedOwnerRevision: owner.ownerRevision });
    } catch (reason) { if (current === generation.current) setError(setupError(reason)); }
    finally { if (current === generation.current) setStopping(false); }
  }
  const owner = row.readiness?.owner;
  return <section className="panel" aria-labelledby="setup-review-title">
    <h2 id="setup-review-title">Conferência e teste</h2>
    {error && <p role="alert">{error}</p>}
    <p>Conexão, vínculo, publicação e entrega real são conferidos separadamente.</p>
    {row.state === 'UNKNOWN' || row.pendingAction ? <>
      <p role="status">Há uma operação com resultado a conferir. A retomada consulta o estado atual antes de repetir qualquer ação.</p>
      <button className="button button--primary" disabled={busy} onClick={() => action('reconcile')}>Conferir e retomar</button>
    </> : <button className="button button--secondary" disabled={busy || row.state === 'CANCELLED'} onClick={() => action('check')}>Conferir configuração</button>}
    {row.readiness && <ul>{row.readiness.checks.map(check => <li key={check.code}>
      <strong>{check.state === 'PASS' ? 'Conferido' : check.state === 'UNVERIFIED' ? 'A conferir' : 'Ação necessária'}:</strong> {check.title}
      {check.state !== 'PASS' && check.actionHref && <> <Link to={check.actionHref}>Abrir configuração</Link></>}
    </li>)}</ul>}
    {['EDITING', 'REVIEW'].includes(row.state) && <fieldset disabled={busy || !row.readiness?.readyForTest}>
      <legend>Homologação por mensagem</legend>
      <label>Palavra exclusiva do teste<input maxLength={100} value={keyword} onChange={event => setKeyword(event.target.value)} /></label>
      {(owner?.automationId || owner?.executor === 'EXTERNAL') && <label><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)} />Confirmo trocar o robô atual desta caixa pelo teste.</label>}
      <p>O teste usa uma cópia do fluxo e responde somente à palavra escolhida.</p>
      <button className="button button--primary" disabled={busy || !row.readiness?.readyForTest || keyword.trim().length < 8}
        onClick={() => action('test', { keyword, expectedOwnerRevision: owner?.revision ?? 0, replaceExisting: replace })}>Iniciar homologação</button>
    </fieldset>}
    {row.test && <div className="panel"><p>Envie de outro WhatsApp a palavra:</p><p><code>{row.test.keyword}</code></p>
      <p>Responda ao menu, solicite atendimento humano e assuma a conversa na caixa JRC para conferir a pausa do robô.</p></div>}
    {row.state === 'TESTING' && <button className="button button--secondary" disabled={busy} onClick={() => action('proof')}>Verificar teste real</button>}
    {row.proof && <div><h3>Resultado do teste {row.proof.provider === 'META' ? 'Meta' : 'QR'}</h3>
      <ul>{row.proof.checks.map(check => <li key={check.code}>{check.state === 'PASS' ? 'Conferido' : 'Pendente'}: {check.title}</li>)}</ul>
    </div>}
    {row.state === 'ACTIVE' ? <p role="status">Atendimento ativo com a versão selecionada.</p> :
      <button className="button button--primary" disabled={busy || row.state !== 'TESTING' || !row.proof?.passed || Boolean(row.pendingAction)}
        onClick={() => action('activate', { expectedOwnerRevision: owner?.revision ?? 0 })}>Ativar atendimento</button>}
    {['TESTING', 'ACTIVE', 'UNKNOWN'].includes(row.state) && <><p>Interromper desativa somente o vínculo deste assistente e mantém as atribuições humanas.</p>
      <button className="button button--secondary" disabled={busy || stopping || !row.selection.channelId} onClick={() => void stop()}>Interromper teste ou atendimento</button></>}
  </section>;
}
