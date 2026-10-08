import { useEffect, useRef, useState } from 'react';
import { UpdateWhatsAppGroupSelectionSchema, WhatsAppGroupCatalogPageSchema,
  type WhatsAppGroupCatalogItem, type WhatsAppGroupCatalogPage, type WhatsAppGroupCatalogSnapshot } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';

type Cursor = NonNullable<WhatsAppGroupCatalogPage['nextCursor']>;
interface View {
  client: ApiClient; channelId: string; page: WhatsAppGroupCatalogPage | null;
  stack: (Cursor | null)[]; error: string; loading: boolean; busy: boolean;
}
function emptyView(client: ApiClient, channelId: string, loading = false): View {
  return { client, channelId, page: null, stack: [null], error: '', loading, busy: false };
}
function stale(page: WhatsAppGroupCatalogPage | null): WhatsAppGroupCatalogPage | null {
  return page ? { ...page, snapshot: { ...page.snapshot, status: 'STALE' } } : null;
}
// Browser UTF8 encoding, independent of Node globals and provider credentials.
function encodeCursor(cursor: Cursor) {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function WhatsAppGroups({ client, channelId, canManage }: { client: ApiClient; channelId: string; canManage: boolean }) {
  const [view, setView] = useState<View>(() => emptyView(client, channelId, true));
  const generation = useRef(0), controllers = useRef(new Set<AbortController>());
  const readController = useRef<AbortController | null>(null), lock = useRef(false);
  const stack = useRef<(Cursor | null)[]>([null]), organization = useRef<string | null>(null), grant = useRef(canManage);
  grant.current = canManage;
  const ownsView = view.client === client && view.channelId === channelId;
  const visible = ownsView ? view : emptyView(client, channelId, true);
  const base = `/v1/channels/${encodeURIComponent(channelId)}/whatsapp-groups`;
  function live(current: number, controller: AbortController) {
    return current === generation.current && !controller.signal.aborted;
  }
  function cancelRead() {
    readController.current?.abort(); readController.current = null;
  }
  function parse(value: unknown, minimum?: WhatsAppGroupCatalogSnapshot) {
    const data = WhatsAppGroupCatalogPageSchema.parse(value);
    if (data.items.length > 50 || data.snapshot.scope.channelId !== channelId
      || organization.current !== null && data.snapshot.scope.organizationId !== organization.current
      || minimum && data.snapshot.snapshotId === minimum.snapshotId && data.snapshot.catalogRevision < minimum.catalogRevision) {
      throw new Error('Invalid catalog response');
    }
    return data;
  }
  async function read(cursors = stack.current, current = generation.current,
    options: { error?: string; minimum?: WhatsAppGroupCatalogSnapshot } = {}): Promise<void> {
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller; controllers.current.add(controller);
    setView(previous => ({ ...previous, loading: true }));
    const cursor = cursors.at(-1), path = `${base}?limit=50${cursor ? `&cursor=${encodeCursor(cursor)}` : ''}`;
    try {
      const data = parse(await client.request<unknown>(path, { signal: controller.signal }), options.minimum);
      if (live(current, controller)) {
        organization.current = data.snapshot.scope.organizationId; stack.current = cursors;
        setView(previous => ({ ...previous, client, channelId, page: data, stack: cursors, error: options.error ?? '' }));
      }
    } catch (error) {
      if (live(current, controller)) {
        if (cursor && error instanceof ApiClientError && error.code === 'GROUP_CATALOG_CHANGED') {
          await read([null], current, options);
        } else {
          const notReady = error instanceof ApiClientError && error.status === 404 && error.code === 'GROUP_CATALOG_NOT_READY';
          const forbidden = error instanceof ApiClientError && [401, 403].includes(error.status);
          setView(previous => ({ ...previous, page: notReady || forbidden ? null : stale(previous.page),
            error: options.error ?? (notReady ? '' : 'Não foi possível consultar os grupos. Recarregue o catálogo para tentar novamente.') }));
        }
      }
    } finally {
      controllers.current.delete(controller);
      if (readController.current === controller) readController.current = null;
      if (live(current, controller)) setView(previous => ({ ...previous, loading: false }));
    }
  }
  useEffect(() => {
    function clear() {
      generation.current++;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear(); readController.current = null; lock.current = false;
      organization.current = null; stack.current = [null];
    }
    clear(); setView(emptyView(client, channelId, true));
    const unregister = client.registerTenantPurge(() => { clear(); setView(emptyView(client, channelId)); });
    void read([null]);
    return () => { clear(); unregister(); };
  }, [client, channelId]);

  async function mutate(item?: WhatsAppGroupCatalogItem) {
    const page = visible.page;
    if (lock.current || !grant.current || visible.loading || item && (!page || page.snapshot.status !== 'CURRENT')) return;
    lock.current = true;
    // Cancel only the read. A subsequent GET never owns this mutation signal.
    cancelRead();
    const current = generation.current, controller = new AbortController(), cursors = stack.current;
    controllers.current.add(controller);
    setView(previous => ({ ...previous, busy: true, loading: false, error: '' }));
    try {
      const body = item && page ? UpdateWhatsAppGroupSelectionSchema.parse({
        expectedSnapshotId: page.snapshot.snapshotId, expectedCatalogRevision: page.snapshot.catalogRevision,
        expectedIdentityRevision: page.snapshot.scope.identityRevision,
        expectedIdentityFingerprint: page.snapshot.scope.identityFingerprint, groupJid: item.groupJid, enabled: !item.selected,
      }) : {};
      const data = parse(await client.request<unknown>(`${base}/${item ? 'selection' : 'refresh'}`, {
        method: item ? 'PUT' : 'POST', body: JSON.stringify(body), signal: controller.signal,
      }));
      if (!live(current, controller)) return;
      cancelRead();
      if (item) {
        // Selection returns the server's first page. It is revision evidence,
        // not the current page, and need not contain the selected group.
        const rebased = cursors.map(cursor => cursor ? { ...cursor, snapshotId: data.snapshot.snapshotId } : null);
        setView(previous => ({ ...previous, page: stale(previous.page) }));
        await read(rebased, current, { minimum: data.snapshot });
      } else {
        organization.current = data.snapshot.scope.organizationId; stack.current = [null];
        setView(previous => ({ ...previous, page: data, stack: [null], loading: false, error: '' }));
      }
    } catch {
      if (live(current, controller)) {
        const error = item ? 'Não foi possível confirmar a seleção. Confira o catálogo antes de tentar novamente.'
          : 'Não foi possível atualizar os grupos do WhatsApp. O catálogo anterior foi preservado; confira seu estado.';
        setView(previous => ({ ...previous, page: stale(previous.page), error }));
        await read(cursors, current, { error });
      }
    } finally {
      controllers.current.delete(controller);
      if (live(current, controller)) { lock.current = false; setView(previous => ({ ...previous, busy: false })); }
    }
  }
  function navigate(direction: 'previous' | 'next') {
    if (lock.current || visible.loading || visible.busy) return;
    if (direction === 'previous' && stack.current.length > 1) void read(stack.current.slice(0, -1));
    else if (direction === 'next' && visible.page?.nextCursor) void read([...stack.current, visible.page.nextCursor]);
  }
  const page = visible.page;
  return <section className="panel" aria-label="Grupos do WhatsApp">
    <div className="panel-heading"><h2>Grupos do WhatsApp</h2></div>
    <p>Selecionar grupos registra sua escolha. Bot e envio em grupos ainda não estão disponíveis.</p>
    {visible.error ? <p className="notice notice--error" role="alert">{visible.error}</p> : null}
    {visible.loading ? <p role="status">Consultando catálogo…</p> : null}
    {page ? <>
      <p><strong>{page.snapshot.status === 'CURRENT' ? 'Atual' : 'Desatualizado'}</strong></p>
      <p>Observado em <time dateTime={page.snapshot.observedAt}>{new Date(page.snapshot.observedAt).toLocaleString('pt-BR')}</time></p>
      {page.snapshot.status === 'STALE' ? <p>Atualize os grupos do WhatsApp antes de alterar a seleção.</p> : null}
      <p>Página {visible.stack.length} · {page.total} grupos no catálogo</p>
      {page.items.length === 0 ? <p>Nenhum grupo foi observado neste catálogo.</p> : <ul>{page.items.map(item => <li key={item.groupJid}>
        <label><input type="checkbox" aria-label={`Selecionar ${item.subject}`} checked={item.selected}
          disabled={!canManage || page.snapshot.status !== 'CURRENT' || visible.busy || visible.loading}
          onChange={() => { void mutate(item); }} /> <span>{item.subject}</span></label>
        <p>{item.participantCount} participantes</p>
      </li>)}</ul>}
      <div className="button-row">
        <button className="button button--secondary" type="button" disabled={visible.stack.length <= 1 || visible.loading || visible.busy} onClick={() => navigate('previous')}>Página anterior</button>
        <button className="button button--secondary" type="button" disabled={!page.nextCursor || visible.loading || visible.busy} onClick={() => navigate('next')}>Próxima página</button>
      </div>
    </> : !visible.loading ? <p>O catálogo ainda não foi consultado. Conecte o WhatsApp e atualize os grupos.</p> : null}
    <div className="button-row">
      <button className="button button--secondary" type="button" disabled={visible.loading} onClick={() => { void read(); }}>Recarregar catálogo</button>
      {canManage ? <button className="button button--primary" type="button" disabled={visible.loading || visible.busy} onClick={() => { void mutate(); }}>Atualizar grupos do WhatsApp</button> : null}
    </div>
    {!canManage ? <p>Somente administradores podem atualizar o WhatsApp e alterar a seleção.</p> : null}
  </section>;
}
