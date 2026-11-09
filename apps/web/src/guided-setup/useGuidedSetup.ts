import { useLayoutEffect, useRef, useState } from 'react';
import type { GuidedSetup, SetupSelection } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { getSetup, parseSetup, setupAction } from './api.js';

export function setupError(error: unknown) {
  if (!(error instanceof ApiClientError)) return 'Não foi possível confirmar a operação. Atualize o andamento antes de repetir.';
  const messages: Record<string, string> = {
    GUIDED_SETUP_CHANGED: 'A configuração mudou. Atualize o andamento antes de continuar.',
    GUIDED_SETUP_OWNER_CHANGED: 'O responsável pela caixa mudou. Confira o vínculo atual.',
    GUIDED_SETUP_CONFIGURATION_CHANGED: 'Número, destino, atendentes ou robô mudaram. Confira a configuração e repita a homologação.',
    GUIDED_SETUP_PHYSICAL_PROOF_REQUIRED: 'Conclua o teste de mensagem, transferência e pausa do robô antes de ativar.',
    GUIDED_SETUP_TEST_INPUT_NOT_RECEIVED: 'Ainda não foi localizada a entrada deste teste. Envie a palavra indicada por outro WhatsApp.',
    GUIDED_SETUP_OPERATION_IN_PROGRESS: 'A operação ainda está em processamento. Aguarde e atualize o andamento.',
    GUIDED_SETUP_RECONCILIATION_REQUIRED: 'Há uma operação a conferir. Use Conferir e retomar antes de alterar os dados.',
    AUTOMATION_PACKAGE_LOCAL_REFERENCES_REQUIRED: 'Selecione os recursos locais indicados nos blocos do robô antes de publicar.',
  };
  return `${messages[error.code ?? ''] ?? error.message}${error.requestId ? ` Solicitação: ${error.requestId}` : ''}`;
}
export function useGuidedSetup(client: ApiClient, org: string, id?: string) {
  const [row, setRow] = useState<GuidedSetup | null>(null), [items, setItems] = useState<GuidedSetup[]>([]);
  const [loading, setLoading] = useState(true), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), mutation = useRef(false);
  const activeScope = useRef<{ client: ApiClient; org: string; id: string | undefined } | null>(null);
  const createIntent = useRef<{ key: string; input: { name: string; transport: 'QR' | 'META' } } | null>(null);
  useLayoutEffect(() => {
    const current = ++generation.current, abort = new AbortController();
    activeScope.current = { client, org, id };
    setRow(null); setItems([]); setError(''); setLoading(true); setBusy(false); setEnabled(false); mutation.current = false; createIntent.current = null;
    void (async () => {
      const availability = await client.request<{ enabled: boolean }>('/v1/guided-setups/availability', { signal: abort.signal });
      if (current !== generation.current) return;
      setEnabled(availability.enabled === true); if (!availability.enabled) return;
      if (id) { const loaded = await getSetup(client, org, id, abort.signal); if (current === generation.current) setRow(loaded); }
      else {
        const result = await client.request<{ data: unknown[] }>('/v1/guided-setups', { signal: abort.signal });
        const parsed = result.data.map(value => parseSetup(org, value)); if (current === generation.current) setItems(parsed);
      }
    })().catch(reason => { if (current === generation.current && !abort.signal.aborted) setError(setupError(reason)); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { activeScope.current = null; generation.current++; abort.abort(); createIntent.current = null; };
  }, [client, org, id]);
  async function work(action: () => Promise<GuidedSetup>) {
    if (mutation.current || activeScope.current?.client !== client || activeScope.current.org !== org || activeScope.current.id !== id) return null;
    const current = generation.current; mutation.current = true; setBusy(true); setError('');
    try {
      const result = await action(); if (current !== generation.current) return null;
      setRow(result); return result;
    } catch (reason) {
      if (current === generation.current) setError(setupError(reason)); return null;
    } finally { if (current === generation.current) { mutation.current = false; setBusy(false); } }
  }
  return { row: row?.organizationId === org ? row : null, items, enabled, loading, busy, error,
    create: (name: string, transport: 'QR' | 'META') => work(async () => {
      createIntent.current ??= { key: crypto.randomUUID(), input: { name: name.trim(), transport } };
      const intent = createIntent.current;
      try {
        const result = parseSetup(org, await client.request('/v1/guided-setups', { method: 'POST', headers: { 'Idempotency-Key': intent.key }, body: JSON.stringify(intent.input) }));
        if (createIntent.current === intent) createIntent.current = null; return result;
      } catch (reason) {
        if (createIntent.current === intent && reason instanceof ApiClientError && [400, 401, 403, 404, 422].includes(reason.status)) createIntent.current = null;
        throw reason;
      }
    }),
    createUncertain: Boolean(createIntent.current),
    refresh: () => row ? work(() => getSetup(client, org, row.id)) : null,
    action: (action: string, input: Record<string, unknown> = {}) => row ? work(() => setupAction(client, org, row, action, input)) : null,
    save: (selection: SetupSelection) => row ? work(async () => parseSetup(org, await client.request(`/v1/guided-setups/${row.id}`, {
      method: 'PUT', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ revision: row.revision, selection }) }))) : null,
  };
}
