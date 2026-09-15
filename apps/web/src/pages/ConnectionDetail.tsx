import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';

import type { ConnectionAction, Instance } from '@jrc/contracts';

import { ApiClientError } from '../api/client.js';
import { useApiClient, useSession } from '../auth/SessionProvider.js';
import { connectConnection, disconnectConnection, getConnection, getConnectionStatus } from '../connections/api.js';
import { ChallengePanel } from '../connections/components/ChallengePanel.js';
import { ConnectionStatus } from '../connections/components/ConnectionStatus.js';
import { InstanceWorkspace } from '../connections/components/InstanceWorkspace.js';
import { canConnect, canDisconnect, isPollingStatus } from '../connections/status.js';
import { useInstancePolling } from '../connections/use-instance-polling.js';
import { useVolatileIntent } from '../connections/use-volatile-intent.js';

function safeError(error: unknown, fallback: string) {
  const apiError = error instanceof ApiClientError ? error : null;
  return { text: apiError?.message ?? fallback, ...(apiError?.requestId ? { requestId: apiError.requestId } : {}) };
}

export function ConnectionDetailPage() {
  const { id = '' } = useParams();
  const client = useApiClient();
  const { session, tenantRevision } = useSession();
  const connectIntent = useVolatileIntent(client);
  const disconnectIntent = useVolatileIntent(client);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [action, setAction] = useState<ConnectionAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connectRetry, setConnectRetry] = useState(false);
  const [pairingHint, setPairingHint] = useState('');
  const [connectionMethod, setConnectionMethod] = useState<'QR' | 'PAIRING'>('QR');
  const [error, setError] = useState<{ text: string; requestId?: string } | null>(null);
  const tenantGeneration = useRef(0);
  const tenantId = session?.activeOrganization.id ?? '';

  const updateStatus = useCallback((next: Instance) => {
    setInstance(next);
    setError(null);
    if (['CONNECTED', 'DISCONNECTED', 'ERROR', 'PROVISIONING_FAILED'].includes(next.status)) setAction(null);
  }, []);
  const pollingError = useCallback((caught: unknown) => {
    setError(safeError(caught, 'Não foi possível atualizar o status.'));
  }, []);

  useEffect(() => {
    const generation = ++tenantGeneration.current;
    let active = true;
    setLoading(true);
    setInstance(null);
    setAction(null);
    setBusy(false);
    setConnectRetry(false);
    setPairingHint('');
    setConnectionMethod('QR');
    setError(null);
    connectIntent.clear();
    disconnectIntent.clear();
    void getConnection(client, id).then((result) => {
      if (active && generation === tenantGeneration.current) setInstance(result);
    }).catch((caught: unknown) => {
      if (active && generation === tenantGeneration.current) {
        setError(safeError(caught, 'Não foi possível carregar a conexão.'));
      }
    }).finally(() => {
      if (active && generation === tenantGeneration.current) setLoading(false);
    });
    const unregister = client.registerTenantPurge(() => {
      active = false;
      tenantGeneration.current += 1;
      setInstance(null);
      setAction(null);
      setBusy(false);
      setConnectRetry(false);
      setPairingHint('');
      setConnectionMethod('QR');
      setError(null);
      setLoading(true);
      connectIntent.clear();
      disconnectIntent.clear();
    });
    return () => {
      active = false;
      if (tenantGeneration.current === generation) tenantGeneration.current += 1;
      unregister();
      setAction(null);
    };
  }, [client, connectIntent, disconnectIntent, id, tenantId, tenantRevision]);

  useInstancePolling({
    client,
    instanceId: id,
    active: instance ? isPollingStatus(instance.status) : false,
    onStatus: updateStatus,
    onError: pollingError,
  });

  const canMutate = session?.activeOrganization.role !== 'VIEWER';

  async function connect() {
    const normalizedNumber = pairingHint.trim().replace(/[+()\s-]/g, '');
    if (connectionMethod === 'PAIRING' && !/^[1-9]\d{7,14}$/.test(normalizedNumber)) {
      setError({ text: 'Informe o número do WhatsApp com código do país, DDD e número.' });
      return;
    }
    const generation = tenantGeneration.current;
    setBusy(true);
    setError(null);
    setAction(null);
    try {
      const result = await connectConnection(
        client,
        id,
        connectionMethod === 'PAIRING' ? { pairingHint: normalizedNumber } : {},
        connectIntent.acquire({ forceNew: !connectRetry }),
      );
      if (generation !== tenantGeneration.current) return;
      setPairingHint('');
      setInstance(result.instance);
      setAction(result.action);
      setConnectRetry(false);
      connectIntent.complete();
    } catch (caught) {
      if (generation !== tenantGeneration.current) return;
      setError(safeError(caught, 'Não foi possível iniciar a conexão.'));
      setConnectRetry(true);
    } finally {
      if (generation === tenantGeneration.current) setBusy(false);
    }
  }

  async function refreshStatus() {
    const generation = tenantGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const result = await getConnectionStatus(client, id);
      if (generation === tenantGeneration.current) {
        updateStatus(result);
        if (['DISCONNECTED', 'ERROR', 'PROVISIONING_FAILED'].includes(result.status)) {
          connectIntent.clear();
          setConnectRetry(false);
        }
      }
    } catch (caught) {
      if (generation === tenantGeneration.current) pollingError(caught);
    } finally {
      if (generation === tenantGeneration.current) setBusy(false);
    }
  }

  function changeMethod(method: 'QR' | 'PAIRING') {
    setConnectionMethod(method);
    setPairingHint('');
    setAction(null);
    setError(null);
    setConnectRetry(false);
    connectIntent.clear();
  }

  async function disconnect() {
    if (!window.confirm('Desconectar este WhatsApp?')) return;
    const generation = tenantGeneration.current;
    setBusy(true);
    setError(null);
    setAction(null);
    try {
      const result = await disconnectConnection(client, id, disconnectIntent.acquire());
      if (generation !== tenantGeneration.current) return;
      setInstance(result.instance);
      disconnectIntent.complete();
    } catch (caught) {
      if (generation !== tenantGeneration.current) return;
      setError(safeError(caught, 'Não foi possível desconectar.'));
    } finally {
      if (generation === tenantGeneration.current) setBusy(false);
    }
  }

  if (loading) return <div className="state-card" aria-busy="true">Carregando conexão…</div>;
  if (!instance) return (
    <section><h1>Conexão indisponível</h1>{error ? <div className="notice notice--error" role="alert">{error.text}{error.requestId ? <small>Solicitação: {error.requestId}</small> : null}</div> : null}</section>
  );

  const actionLabel = instance.status === 'AWAITING_ACTION' ? 'Gerar novo desafio' : connectRetry || instance.status === 'CONNECTING' ? 'Tentar conexão novamente' : 'Conectar';
  return (
    <section aria-labelledby="connection-title">
      <Link className="back-link" to="/conexoes">← Voltar para conexões</Link>
      <div className="page-heading">
        <div><p className="eyebrow">WhatsApp Business por QR Code</p><h1 id="connection-title">{instance.name}</h1></div>
        <ConnectionStatus status={instance.status} />
      </div>
      {!canMutate ? <p className="notice">Seu acesso é somente leitura.</p> : null}
      <InstanceWorkspace key={`${tenantId}:${tenantRevision}:${id}`} instanceId={id} />
      {instance.status === 'PROVISIONING_FAILED' ? (
        <div className="notice notice--error" role="alert">
          <p>A conexão não foi criada no serviço de WhatsApp. O QR Code ainda não pode ser gerado.</p>
          <p>Solicite à equipe JRC a verificação do serviço. Após a normalização, crie uma nova conexão; este registro será preservado.</p>
          <Link to="/conexoes">Voltar à lista de conexões</Link>
        </div>
      ) : null}
      {error ? <div className="notice notice--error" role="alert">{error.text}{error.requestId ? <small>Solicitação: {error.requestId}</small> : null}</div> : null}
      {instance.status === 'AWAITING_ACTION' && action === null ? (
        <p className="notice">O desafio anterior não fica armazenado por segurança. Gere um novo desafio quando estiver pronto.</p>
      ) : null}
      {instance.status === 'CONNECTING' && action === null ? (
        <p className="notice">O serviço está preparando o pareamento. Aguarde alguns segundos e use Tentar conexão novamente para solicitar um novo desafio.</p>
      ) : null}
      {action ? <ChallengePanel action={action} onExpire={() => setAction(null)} /> : null}
      <button className="button button--ghost" type="button" disabled={busy} onClick={() => void refreshStatus()}>Atualizar status</button>
      {canMutate && (canConnect(instance.status) || canDisconnect(instance.status)) ? (
        <div className="panel action-panel">
          {canConnect(instance.status) ? (
            <>
              <fieldset className="connection-method" disabled={busy}>
                <legend>Como deseja conectar?</legend>
                <label><input type="radio" name="connection-method" checked={connectionMethod === 'QR'} onChange={() => changeMethod('QR')} /> QR Code</label>
                <label><input type="radio" name="connection-method" checked={connectionMethod === 'PAIRING'} onChange={() => changeMethod('PAIRING')} /> Código de pareamento</label>
              </fieldset>
              {connectionMethod === 'PAIRING' ? <>
                <label htmlFor="pairing-hint">Número do WhatsApp</label>
                <input id="pairing-hint" type="tel" autoComplete="off" aria-describedby="pairing-help" disabled={busy} maxLength={64} value={pairingHint} onChange={(event) => { setPairingHint(event.target.value); setAction(null); connectIntent.clear(); setConnectRetry(false); }} />
                <p id="pairing-help">Informe código do país, DDD e número. No celular, escolha conectar um aparelho usando número de telefone.</p>
              </> : <p>No WhatsApp do celular, abra Aparelhos conectados e escolha Conectar um aparelho para ler o QR Code.</p>}
              <button className="button button--primary" type="button" disabled={busy} onClick={() => void connect()}>{busy ? 'Processando…' : actionLabel}</button>
            </>
          ) : null}
          {canDisconnect(instance.status) ? <button className="button button--danger" type="button" disabled={busy} onClick={() => void disconnect()}>Desconectar</button> : null}
        </div>
      ) : null}
    </section>
  );
}
