import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { welcomeFlow, type AutomationDefinitionV1, type AutomationGraphV1 } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { ImportReview, type ImportReport } from '../automations/ImportReview.js';
import { AutomationAvailabilityNotice, type AutomationAvailability } from '../automations/AvailabilityNotice.js';
const message = (reason: unknown) => reason instanceof Error ? reason.message : 'Não foi possível consultar o Flow.';

export function NativeWorkspace({ client, canEdit }: { client: ApiClient; canEdit: boolean }) {
  const [data, setData] = useState<AutomationDefinitionV1[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [status, setStatus] = useState<AutomationAvailability | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  async function load(next?: string) {
    controller.current?.abort(); const pending = new AbortController(); controller.current = pending;
    const current = ++generation.current; setBusy(true); setError('');
    try {
      const result = await client.request<{ data: AutomationDefinitionV1[]; nextCursor: string | null }>(
        '/v1/automations' + (next ? '?cursor=' + next : ''), { signal: pending.signal });
      if (current === generation.current) { setData(items => next ? [...items, ...result.data] : result.data); setCursor(result.nextCursor); }
    } catch (reason) { if (current === generation.current && !pending.signal.aborted) setError(message(reason)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  useEffect(() => {
    void load(); const availability = new AbortController();
    void client.request<AutomationAvailability>('/v1/automations/status', { signal: availability.signal })
      .then(value => { if (!availability.signal.aborted) setStatus(value); }).catch(() => {});
    return () => { generation.current++; controller.current?.abort(); availability.abort(); };
  }, [client]);
  return <section className="automation-page"><h1>Flows das caixas selecionadas</h1><AutomationAvailabilityNotice status={status} />
    {canEdit && status?.canEdit && <Link to="/automations/new">Nova automação ou importar</Link>}
    {error && <p role="alert">{error}</p>}{!busy && !error && !data.length && <p>Crie seu primeiro fluxo para estas caixas.</p>}
    <div className="automation-cards">{data.map(item => <article key={item.id}><h2>{item.name}</h2>
      <p>{item.activeVersion ? `Versão publicada: ${item.activeVersion}` : 'Rascunho'}</p>
      <Link to={`/automations/${item.id}/edit`}>Abrir editor</Link> · <Link to={`/automations/${item.id}/versions`}>Histórico</Link> · <Link to={`/automations/${item.id}/bind`}>Vincular caixa</Link>
    </article>)}</div>{cursor && <button disabled={busy} onClick={() => void load(cursor)}>Carregar mais</button>}</section>;
}
type Preview = { name: string; graph: AutomationGraphV1; report: ImportReport };
export function NativeNewFlow({ client, canEdit }: { client: ApiClient; canEdit: boolean }) {
  const navigate = useNavigate(), [name, setName] = useState(''), [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), key = useRef(crypto.randomUUID());
  const controller = useRef(new AbortController()), mutation = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current.abort(); }, []);
  async function read(file: File) {
    if (!canEdit || mutation.current) return;
    if (file.size > 2_097_152) { setError('O arquivo excede o limite de importação.'); return; }
    const current = ++generation.current; mutation.current = true; setBusy(true); setError('');
    try {
      const content = await file.text(); if (controller.current.signal.aborted) return;
      const result = await client.request<Preview>('/v1/automation-imports/preview', { method: 'POST',
        signal: controller.current.signal, body: JSON.stringify({ source: 'AUTO', content }) });
      if (current === generation.current) { setPreview(result); setName(result.name); key.current = crypto.randomUUID(); }
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) { mutation.current = false; setBusy(false); } }
  }
  async function create() {
    if (!canEdit || mutation.current || !name.trim()) return;
    const current = ++generation.current; mutation.current = true; setBusy(true); setError('');
    try {
      const item = await client.request<AutomationDefinitionV1>('/v1/automations', { method: 'POST',
        signal: controller.current.signal, headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify({ name, graph: preview?.graph ?? welcomeFlow() }) });
      if (current === generation.current) navigate(`/automations/${item.id}/edit`, { state: preview ? { importReport: preview.report } : null });
    } catch (reason) { if (current === generation.current) setError(message(reason)); }
    finally { if (current === generation.current) { mutation.current = false; setBusy(false); } }
  }
  return <section className="automation-page automation-narrow"><Link to="/automations">Voltar</Link><h1>Nova automação</h1>
    {error && <p role="alert">{error}</p>}<form onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>Nome<input disabled={!canEdit || busy} required maxLength={160} value={name} onChange={event => { setName(event.target.value); key.current = crypto.randomUUID(); }} /></label>
      <label>Importar arquivo JSON<input type="file" accept="application/json,.json" disabled={!canEdit || busy} onChange={event => { const file = event.target.files?.[0]; if (file) void read(file); event.target.value = ''; }} /></label>
      {preview && <ImportReview report={preview.report} />}<button disabled={!canEdit || busy || !name.trim()}>Criar rascunho e abrir editor</button>
    </form></section>;
}
export function NativeVersions({ client }: { client: ApiClient }) {
  const { id = '' } = useParams(), [data, setData] = useState<Array<{ version: number; graph: AutomationGraphV1; publishedAt: string }>>([]);
  const [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  async function load(next?: string) {
    controller.current?.abort(); const pending = new AbortController(); controller.current = pending; setBusy(true);
    try {
      const result = await client.request<{ data: typeof data; nextCursor: string | null }>(`/v1/automations/${id}/versions` + (next ? '?cursor=' + next : ''), { signal: pending.signal });
      if (!pending.signal.aborted) { setData(current => next ? [...current, ...result.data] : result.data); setCursor(result.nextCursor); }
    } catch (reason) { if (!pending.signal.aborted) setError(message(reason)); }
    finally { if (!pending.signal.aborted) setBusy(false); }
  }
  useEffect(() => { setData([]); setCursor(null); setError(''); void load(); return () => controller.current?.abort(); }, [client, id]);
  return <section className="automation-page"><Link to={`/automations/${id}/edit`}>Voltar ao editor</Link><h1>Histórico de versões</h1>
    {error && <p role="alert">{error}</p>}{data.map(version => <p key={version.version}>Versão {version.version} · {version.graph.nodes.length} blocos · {new Date(version.publishedAt).toLocaleString('pt-BR')}</p>)}
    {cursor && <button disabled={busy} onClick={() => void load(cursor)}>Carregar versão anterior</button>}</section>;
}
