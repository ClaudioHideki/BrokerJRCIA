// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WhatsAppGroupCatalogPage } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { WhatsAppGroups } from './WhatsAppGroups.js';

const channelId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const otherChannel = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const org = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
const snapshotId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
const newSnapshotId = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc';
const base = `/v1/channels/${channelId}/whatsapp-groups`;
type Cursor = NonNullable<WhatsAppGroupCatalogPage['nextCursor']>;
function group(subject = 'Equipe de teste', groupJid = '100-200@g.us', selected = false) {
  return { groupJid, subject, selected, participantCount: 12, restrict: null, announce: false,
    isCommunity: null, isCommunityAnnounce: null, linkedParent: null, automationEnabled: false as const };
}
function page(overrides: Partial<WhatsAppGroupCatalogPage> = {}): WhatsAppGroupCatalogPage {
  return { snapshot: { schemaVersion: 1, scope: { provider: 'QR', organizationId: org, channelId,
    identityRevision: 2, identityFingerprint: 'a'.repeat(64) }, snapshotId, catalogRevision: 7,
    observedAt: '2026-10-08T11:00:00Z', status: 'CURRENT', lastAttemptAt: '2026-10-08T11:00:00Z', lastErrorCode: null },
    items: [group()], total: 1, nextCursor: null, ...overrides };
}
function api(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  let purge: (() => void) | undefined;
  const unregister = vi.fn();
  const client = { request: vi.fn(request), registerTenantPurge: vi.fn((handler: () => void) => { purge = handler; return unregister; }) } as unknown as ApiClient;
  return { client, purge: () => purge?.(), unregister };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function decode(path: string): Cursor | null {
  const value = new URL(path, 'https://example.invalid').searchParams.get('cursor');
  return value ? JSON.parse(atob(value.replace(/-/gu, '+').replace(/_/gu, '/'))) as Cursor : null;
}

it('consulta pelo UUID canônico e apresenta seleção sem prometer bot ou envio', async () => {
  const { client } = api(async () => page());
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  expect(await screen.findByRole('checkbox', { name: 'Selecionar Equipe de teste' })).not.toBeChecked();
  expect(client.request).toHaveBeenCalledWith(`${base}?limit=50`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(screen.getByText('12 participantes')).toBeVisible();
  expect(screen.getByText('Atual')).toBeVisible();
  expect(screen.getByText('Selecionar grupos registra sua escolha. Bot e envio em grupos ainda não estão disponíveis.')).toBeVisible();
  expect(screen.getByText('Observado em', { exact: false })).toBeVisible();
});

it('permite consulta e recarga ao operador, mas não mutações', async () => {
  const { client } = api(async () => page());
  render(<WhatsAppGroups client={client} channelId={channelId} canManage={false} />);
  expect(await screen.findByRole('checkbox')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Atualizar grupos do WhatsApp' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Recarregar catálogo' }));
  await waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
  expect(vi.mocked(client.request).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('não permite selecionar a partir de catálogo desatualizado', async () => {
  const data = page(); data.snapshot.status = 'STALE'; data.snapshot.lastErrorCode = 'PROVIDER_TIMEOUT';
  const { client } = api(async () => data);
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  expect(await screen.findByRole('checkbox')).toBeDisabled();
  expect(screen.getByText('Desatualizado')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Atualizar grupos do WhatsApp' })).toBeEnabled();
});

it('trata ausência de catálogo como instrução, sem exibir erro bruto', async () => {
  const { client } = api(async () => { throw new ApiClientError('segredo bruto', 404, undefined, 'GROUP_CATALOG_NOT_READY'); });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  expect(await screen.findByText('O catálogo ainda não foi consultado. Conecte o WhatsApp e atualize os grupos.')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('segredo bruto')).toBeNull();
  expect(screen.getByRole('button', { name: 'Atualizar grupos do WhatsApp' })).toBeEnabled();
});

it('apresenta catálogo atual vazio sem confundi-lo com ausência de consulta', async () => {
  const { client } = api(async () => page({ items: [], total: 0 }));
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  expect(await screen.findByText('Nenhum grupo foi observado neste catálogo.')).toBeVisible();
  expect(screen.getByText('Atual')).toBeVisible();
});

it('atualiza o catálogo com POST vazio e nenhuma habilitação implícita', async () => {
  const { client } = api(async (_path, init) => init?.method === 'POST' ? page({ items: [group('Catálogo renovado')] }) : page());
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  await screen.findByRole('checkbox');
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar grupos do WhatsApp' }));
  expect(await screen.findByRole('checkbox', { name: 'Selecionar Catálogo renovado' })).not.toBeChecked();
  expect(client.request).toHaveBeenCalledWith(`${base}/refresh`, expect.objectContaining({ method: 'POST', body: '{}', signal: expect.any(AbortSignal) }));
});

it('preserva catálogo após falha de refresh, marca STALE e consulta estado confirmado', async () => {
  const recovery = deferred<unknown>(); let reads = 0;
  const { client } = api(async (_path, init) => {
    if (init?.method === 'POST') throw new Error('credencial secreta <script>');
    return ++reads === 1 ? page() : recovery.promise;
  });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  await screen.findByRole('checkbox');
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar grupos do WhatsApp' }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.getByRole('checkbox', { name: 'Selecionar Equipe de teste' })).toBeDisabled();
  expect(screen.getByText('Desatualizado')).toBeVisible();
  expect(screen.getByRole('alert')).not.toHaveTextContent('credencial');
  const stale = page(); stale.snapshot.status = 'STALE'; stale.snapshot.lastErrorCode = 'PROVIDER_TIMEOUT';
  await act(async () => { recovery.resolve(stale); });
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByText('12 participantes')).toBeVisible();
});

it('usa checkbox nativo acessível por teclado e envia todas as expectativas de revisão', async () => {
  let selected = false;
  const { client } = api(async (_path, init) => {
    if (init?.method === 'PUT') selected = true;
    const data = page({ items: [group('Equipe de teste', '100-200@g.us', selected)] });
    data.snapshot.catalogRevision = selected ? 8 : 7; return data;
  });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  const checkbox = await screen.findByRole('checkbox', { name: 'Selecionar Equipe de teste' }) as HTMLInputElement;
  expect(checkbox.tagName).toBe('INPUT'); expect(checkbox.type).toBe('checkbox'); expect(checkbox.tabIndex).toBe(0);
  checkbox.focus(); expect(checkbox).toHaveFocus();
  // JSDOM does not synthesize the native Space default action. The click below
  // represents its browser activation, using the same onChange as pointer input.
  fireEvent.keyDown(checkbox, { key: ' ' }); fireEvent.keyUp(checkbox, { key: ' ' }); fireEvent.click(checkbox);
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
  expect(client.request).toHaveBeenCalledWith(`${base}/selection`, expect.objectContaining({ method: 'PUT', body: JSON.stringify({
    expectedSnapshotId: snapshotId, expectedCatalogRevision: 7, expectedIdentityRevision: 2,
    expectedIdentityFingerprint: 'a'.repeat(64), groupJid: '100-200@g.us', enabled: true,
  }) }));
});

it('desmarca uma seleção com enabled false sem habilitar automação', async () => {
  let selected = true;
  const { client } = api(async (_path, init) => {
    if (init?.method === 'PUT') selected = false;
    return page({ items: [group('Equipe de teste', '100-200@g.us', selected)] });
  });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  fireEvent.click(await screen.findByRole('checkbox'));
  await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  const call = vi.mocked(client.request).mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ enabled: false });
  expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty('automationEnabled');
});

it('pagina com cursor base64url de JSON e volta pela pilha local', async () => {
  const cursor = { snapshotId, afterGroupJid: '100-200@g.us' };
  const { client } = api(async path => decode(path) ? page({ items: [group('Segunda página', '300@g.us')], total: 2 }) : page({ total: 2, nextCursor: cursor }));
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  await screen.findByRole('checkbox');
  expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
  await screen.findByRole('checkbox', { name: 'Selecionar Segunda página' });
  expect(decode(String(vi.mocked(client.request).mock.calls[1]?.[0]))).toEqual(cursor);
  const encoded = new URL(String(vi.mocked(client.request).mock.calls[1]?.[0]), 'https://example.invalid').searchParams.get('cursor')!;
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
  expect(screen.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Página anterior' }));
  await screen.findByRole('checkbox', { name: 'Selecionar Equipe de teste' });
  expect(vi.mocked(client.request).mock.calls[2]?.[0]).toBe(`${base}?limit=50`);
});

it('seleciona na página dois e recarrega essa página com snapshot/revisão novos', async () => {
  let selected = false;
  const first = () => { const data = page({ items: [group('Primeira página')], total: 2, nextCursor: { snapshotId: selected ? newSnapshotId : snapshotId, afterGroupJid: '100-200@g.us' } });
    data.snapshot.snapshotId = selected ? newSnapshotId : snapshotId; data.snapshot.catalogRevision = selected ? 8 : 7; return data; };
  const { client } = api(async (path, init) => {
    if (init?.method === 'PUT') { selected = true; return first(); }
    const cursor = decode(path);
    if (!cursor) return first();
    expect(cursor.snapshotId).toBe(selected ? newSnapshotId : snapshotId);
    const data = page({ items: [group('Segunda página', '300@g.us', selected)], total: 2 });
    data.snapshot.snapshotId = selected ? newSnapshotId : snapshotId; data.snapshot.catalogRevision = selected ? 8 : 7; return data;
  });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  await screen.findByRole('checkbox'); fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Selecionar Segunda página' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Selecionar Segunda página' })).toBeChecked());
  expect(screen.queryByRole('checkbox', { name: 'Selecionar Primeira página' })).toBeNull();
  const reads = vi.mocked(client.request).mock.calls.filter(([, init]) => !init?.method);
  expect(decode(String(reads[2]?.[0]))).toEqual({ snapshotId: newSnapshotId, afterGroupJid: '100-200@g.us' });
});

it('reinicia paginação se outro refresh substituir o snapshot', async () => {
  let reads = 0;
  const { client } = api(async () => {
    reads++; if (reads === 2) throw new ApiClientError('interno', 409, undefined, 'GROUP_CATALOG_CHANGED');
    return page({ items: [group(reads === 1 ? 'Antes' : 'Depois')], total: 2, nextCursor: { snapshotId, afterGroupJid: '100-200@g.us' } });
  });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  await screen.findByRole('checkbox'); fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
  await screen.findByRole('checkbox', { name: 'Selecionar Depois' });
  expect(vi.mocked(client.request).mock.calls[2]?.[0]).toBe(`${base}?limit=50`);
  expect(screen.getByRole('button', { name: 'Página anterior' })).toBeDisabled();
});

it('bloqueia duplo clique e conserva seleção confirmada enquanto PUT está aberto', async () => {
  const pending = deferred<unknown>(); let writes = 0;
  const { client } = api(async (_path, init) => { if (init?.method === 'PUT') { writes++; return pending.promise; } return page(); });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  const checkbox = await screen.findByRole('checkbox'); fireEvent.click(checkbox); fireEvent.click(checkbox);
  expect(writes).toBe(1); expect(checkbox).toBeDisabled(); expect(checkbox).not.toBeChecked();
  await act(async () => { pending.resolve(page()); });
  await waitFor(() => expect(checkbox).toBeEnabled());
});

it('revoga controles com tela aberta sem abortar mutação em andamento', async () => {
  const pending = deferred<unknown>(); let signal: AbortSignal | null | undefined, writes = 0;
  const { client } = api(async (_path, init) => { if (init?.method === 'PUT') { writes++; signal = init.signal; return pending.promise; } return page(); });
  const view = render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  fireEvent.click(await screen.findByRole('checkbox'));
  view.rerender(<WhatsAppGroups client={client} channelId={channelId} canManage={false} />);
  expect(signal?.aborted).toBe(false); expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Atualizar grupos do WhatsApp' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox')); expect(writes).toBe(1);
  await act(async () => { pending.resolve(page()); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Recarregar catálogo' })).toBeEnabled());
  expect(screen.getByRole('checkbox')).toBeDisabled();
});

it('uma recarga GET não aborta PUT e o commit recarrega o estado posterior', async () => {
  const pending = deferred<unknown>(); let selected = false, signal: AbortSignal | null | undefined, reads = 0, writes = 0;
  const { client } = api(async (_path, init) => {
    if (init?.method === 'PUT') { writes++; signal = init.signal; return pending.promise; }
    reads++; return page({ items: [group('Equipe de teste', '100-200@g.us', selected)] });
  });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  fireEvent.click(await screen.findByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Recarregar catálogo' }));
  await waitFor(() => expect(reads).toBe(2)); expect(signal?.aborted).toBe(false);
  expect(screen.getByRole('checkbox')).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox')); expect(writes).toBe(1);
  await act(async () => { selected = true; pending.resolve(page({ items: [group('Equipe de teste', '100-200@g.us', true)] })); });
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
  expect(reads).toBe(3); expect(signal?.aborted).toBe(false);
});

it('falha de seleção não altera checkbox e relê o catálogo STALE', async () => {
  let reads = 0;
  const { client } = api(async (_path, init) => {
    if (init?.method === 'PUT') throw new ApiClientError('token privado', 409, undefined, 'GROUP_IDENTITY_CHANGED');
    const data = page(); if (++reads > 1) data.snapshot.status = 'STALE'; return data;
  });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  fireEvent.click(await screen.findByRole('checkbox'));
  await screen.findByRole('alert'); await waitFor(() => expect(reads).toBe(2));
  expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByRole('alert')).not.toHaveTextContent('token privado');
});

it('não aceita GET anterior à revisão confirmada pelo PUT', async () => {
  const { client } = api(async (_path, init) => { const data = page(); if (init?.method === 'PUT') data.snapshot.catalogRevision = 8; return data; });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  fireEvent.click(await screen.findByRole('checkbox'));
  await screen.findByRole('alert');
  expect(screen.getByRole('checkbox')).toBeDisabled(); expect(screen.getByText('Desatualizado')).toBeVisible();
});

it('troca de canal aborta mutação antiga e descarta seu retorno tardio', async () => {
  const pending = deferred<unknown>(); let signal: AbortSignal | null | undefined;
  const { client } = api(async (path, init) => {
    if (init?.method === 'PUT') { signal = init.signal; return pending.promise; }
    if (path.includes(otherChannel)) { const data = page({ items: [group('Outra caixa')] }); data.snapshot.scope.channelId = otherChannel; return data; }
    return page();
  });
  const view = render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  fireEvent.click(await screen.findByRole('checkbox'));
  view.rerender(<WhatsAppGroups client={client} channelId={otherChannel} canManage />);
  expect(screen.queryByText('Equipe de teste')).toBeNull();
  expect(await screen.findByRole('checkbox', { name: 'Selecionar Outra caixa' })).toBeEnabled();
  expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(page({ items: [group('Retorno antigo')] })); });
  expect(screen.queryByText('Retorno antigo')).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Selecionar Outra caixa' })).toBeEnabled();
});

it('troca de cliente descarta GET anterior mesmo se o transporte ignorar abort', async () => {
  const pending = deferred<unknown>(); let signal: AbortSignal | null | undefined;
  const old = api(async (_path, init) => { signal = init?.signal; return pending.promise; });
  const next = api(async () => page({ items: [group('Nova organização')] }));
  const view = render(<WhatsAppGroups client={old.client} channelId={channelId} canManage />);
  view.rerender(<WhatsAppGroups client={next.client} channelId={channelId} canManage />);
  await screen.findByRole('checkbox', { name: 'Selecionar Nova organização' }); expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(page({ items: [group('Dados antigos')] })); });
  expect(screen.queryByText('Dados antigos')).toBeNull(); expect(old.unregister).toHaveBeenCalledTimes(1);
});

it('limpa dados e aborta trabalho quando ApiClient purga o tenant', async () => {
  const pending = deferred<unknown>(); let signal: AbortSignal | null | undefined;
  const { client, purge } = api(async (_path, init) => { if (init?.method === 'PUT') { signal = init.signal; return pending.promise; } return page(); });
  render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  fireEvent.click(await screen.findByRole('checkbox'));
  act(() => { purge(); }); expect(screen.queryByRole('checkbox')).toBeNull(); expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(page()); }); expect(screen.queryByRole('checkbox')).toBeNull();
});

it('aborta GET ao desmontar o painel', async () => {
  const pending = deferred<unknown>(); let signal: AbortSignal | null | undefined;
  const { client, unregister } = api(async (_path, init) => { signal = init?.signal; return pending.promise; });
  const view = render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
  view.unmount(); expect(signal?.aborted).toBe(true); expect(unregister).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(page()); });
});

describe('validação estrita e privacidade da resposta', () => {
  it.each([
    ['campo adicional', () => ({ ...page(), providerSecret: 'credencial privada' })],
    ['automação indevida', () => ({ ...page(), items: [{ ...group(), automationEnabled: true }] })],
    ['canal divergente', () => { const data = page(); data.snapshot.scope.channelId = otherChannel; return data; }],
    ['cursor divergente', () => ({ ...page(), nextCursor: { snapshotId: newSnapshotId, afterGroupJid: '100-200@g.us' } })],
    ['página maior que limite pedido', () => page({ total: 51, items: Array.from({ length: 51 }, (_, i) => group(`Grupo ${i}`, `${1000 + i}@g.us`)) })],
  ])('rejeita %s sem renderizar payload', async (_name, value) => {
    const { client } = api(async () => value());
    render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
    expect(await screen.findByRole('alert')).not.toHaveTextContent('credencial privada');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('remove catálogo se consulta passar a ser proibida', async () => {
    let reads = 0;
    const { client } = api(async () => { if (++reads > 1) throw new ApiClientError('detalhe proibido', 403); return page(); });
    render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
    await screen.findByRole('checkbox'); fireEvent.click(screen.getByRole('button', { name: 'Recarregar catálogo' }));
    await screen.findByRole('alert'); expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('alert')).not.toHaveTextContent('detalhe proibido');
  });

  it('não aceita mudar organizationId em respostas da mesma sessão', async () => {
    let reads = 0;
    const { client } = api(async () => { const data = page(); if (++reads > 1) data.snapshot.scope.organizationId = otherChannel; return data; });
    render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
    await screen.findByRole('checkbox'); fireEvent.click(screen.getByRole('button', { name: 'Recarregar catálogo' }));
    await screen.findByRole('alert'); expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('renderiza nomes e caracteres UTF8 como texto, nunca como HTML', async () => {
    const subject = '<img src=x onerror=alert(1)> Equipe São João 🦜';
    const { client } = api(async () => page({ items: [group(subject)] }));
    const view = render(<WhatsAppGroups client={client} channelId={channelId} canManage />);
    expect(await screen.findByText(subject)).toBeVisible(); expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByRole('checkbox', { name: `Selecionar ${subject}` })).toBeEnabled();
  });
});
