// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActionCatalogPage, AutomationMediaAsset, FlowNode } from '@jrc/contracts';
import type { ConversationActionTransport } from '../conversation-api.js';
import { ConversationActionEditor } from './ConversationActionEditor.js';

const org = '11111111-2222-4333-8444-555555555555', root = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const channel = '12345678-1234-4234-8234-123456789abc', resource = '99999999-2222-4333-8444-555555555555';
const scope = { organizationId: org, rootAutomationId: root, channelId: channel }, supported = { state: 'SUPPORTED' as const, reason: null };
const catalog: ActionCatalogPage = { schemaVersion: 1, scope, profile: 'STANDALONE',
  capabilities: { tag: supported, attribute: supported, note: supported, resolve: supported, media: supported },
  data: [{ id: resource, name: 'Urgente', kind: 'LABEL', revision: 'a'.repeat(64), definition: null }], nextCursor: null };
const asset: AutomationMediaAsset = { schemaVersion: 1, scope, id: resource, revision: 2, status: 'READY', name: 'teste.png',
  kind: 'image', mimeType: 'image/png', byteSize: 3 };
function transport(): ConversationActionTransport {
  return { organizationId: org, rootAutomationId: root, listChannels: vi.fn(async () => [{ id: channel, name: 'Caixa de suporte' }]),
    actionCatalog: vi.fn(async () => catalog), mediaCatalog: vi.fn(async () => [asset]), saveResource: vi.fn(async () => {}),
    uploadMedia: vi.fn(async () => asset), revokeMedia: vi.fn(async () => {}) };
}
const node = (type = 'tag', data: Record<string, unknown> = {}): FlowNode => ({ id: 'effect', type, label: 'Ação', position: { x: 0, y: 0 },
  data: { conversationEffectVersion: 2, channelId: channel, operation: type, target: 'action.result', timeoutMs: 15000, ...data } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('scoped conversation action editor', () => {
  it('configures a native task by owner name and keeps public sending separate',async()=>{
    const api=transport(),change=vi.fn();
    vi.mocked(api.actionCatalog).mockResolvedValue({...catalog,profile:'CENTRAL',capabilities:{...catalog.capabilities,
      domain:{...supported,owners:[{id:7,name:'Synthetic operator'}]}}});
    render(<ConversationActionEditor node={node('domain',{command:'create_task',ownerId:7,title:'Follow up',dueAt:{kind:'LITERAL',value:'2026-11-01T12:00:00Z'}})} editable transport={api} onChange={change}/>);
    expect(await screen.findByRole('option',{name:'Synthetic operator'})).toBeVisible();
    fireEvent.change(screen.getByLabelText('Título da tarefa ou reunião'),{target:{value:'Review the request'}});
    expect(change).toHaveBeenCalledWith(expect.objectContaining({command:'create_task',ownerId:7,title:'Review the request'}));
    expect(screen.getByText(/Nenhuma mensagem ou convite externo é enviado/)).toBeVisible();
    expect(api.saveResource).not.toHaveBeenCalled();
  });
  it('chooses a label by name and preserves the resource revision without fetching unrelated media', async () => {
    const api = transport(), change = vi.fn();
    render(<ConversationActionEditor node={node()} editable transport={api} onChange={change} />);
    expect(await screen.findByRole('option', { name: 'Urgente' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Caixa de suporte' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Etiqueta'), { target: { value: resource } });
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ resourceId: resource, resourceRevision: 'a'.repeat(64), conversationEffectVersion: 2 }));
    expect(api.mediaCatalog).not.toHaveBeenCalled();
    expect(screen.queryByText(resource)).toBeNull();
  });
  it('keeps boolean false and numeric zero typed when selecting an attribute', async () => {
    const api = transport(), change = vi.fn();
    vi.mocked(api.actionCatalog).mockResolvedValue({ ...catalog, data: [{ id: resource, name: 'Ativo', kind: 'ATTRIBUTE', revision: 'b'.repeat(64),
      definition: { valueType: 'boolean', maxLength: 4096, allowedValues: [] } }] });
    render(<ConversationActionEditor node={node('attribute')} editable transport={api} onChange={change} />);
    await screen.findByRole('option', { name: 'Ativo' });
    fireEvent.change(screen.getByLabelText('Atributo da conversa'), { target: { value: resource } });
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ valueSource: { kind: 'LITERAL', value: false } }));
  });
  it('ignores a late catalog after the root changes and clears the old selection', async () => {
    const old = transport(), pending = deferred<ActionCatalogPage>(), next = { ...transport(), rootAutomationId: resource };
    vi.mocked(old.actionCatalog).mockReturnValue(pending.promise);
    vi.mocked(next.actionCatalog).mockResolvedValue({ ...catalog, scope: { ...scope, rootAutomationId: resource }, data: [] });
    const { rerender } = render(<ConversationActionEditor node={node()} editable transport={old} onChange={vi.fn()} />);
    await waitFor(() => expect(old.actionCatalog).toHaveBeenCalled());
    const signal = vi.mocked(old.actionCatalog).mock.calls[0]![1]!;
    rerender(<ConversationActionEditor node={node()} editable transport={next} onChange={vi.fn()} />);
    await waitFor(() => expect(next.actionCatalog).toHaveBeenCalled());
    await act(async () => { pending.resolve(catalog); });
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('option', { name: 'Urgente' })).toBeNull();
  });
  it('pins a READY private upload but never publishes a storing file as ready', async () => {
    const api = transport(), change = vi.fn(), mediaNode = node('media', { mediaEffectVersion: 2, mediaId: '', mediaRevision: 1, caption: '' });
    const { rerender } = render(<ConversationActionEditor node={mediaNode} editable transport={api} onChange={change} />);
    await screen.findByRole('option', { name: 'teste.png' });
    fireEvent.change(screen.getByLabelText('Enviar arquivo privado'), { target: { files: [new File(['abc'], 'teste.png', { type: 'image/png' })] } });
    await waitFor(() => expect(change).toHaveBeenCalledWith(expect.objectContaining({ mediaId: resource, mediaRevision: 2 })));
    change.mockReset();
    vi.mocked(api.uploadMedia).mockResolvedValue({ ...asset, status: 'STORING' });
    rerender(<ConversationActionEditor node={mediaNode} editable transport={api} onChange={change} />);
    await waitFor(() => expect(screen.getByLabelText('Enviar arquivo privado')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('Enviar arquivo privado'), { target: { files: [new File(['abc'], 'teste.png', { type: 'image/png' })] } });
    expect(await screen.findByText(/Arquivo recebido.*aguardando confirmação/i)).toBeVisible();
    expect(change).not.toHaveBeenCalled();
  });
  it('does not attach an upload that completes after changing root or node', async () => {
    const old = transport(), next = { ...transport(), rootAutomationId: resource }, upload = deferred<AutomationMediaAsset>(), change = vi.fn();
    vi.mocked(old.uploadMedia).mockReturnValue(upload.promise);
    const mediaNode = node('media', { mediaEffectVersion: 2, mediaId: '', mediaRevision: 1, caption: '' });
    const { rerender } = render(<ConversationActionEditor node={mediaNode} editable transport={old} onChange={change} />);
    await screen.findByRole('option', { name: 'teste.png' });
    fireEvent.change(screen.getByLabelText('Enviar arquivo privado'), { target: { files: [new File(['abc'], 'teste.png', { type: 'image/png' })] } });
    await waitFor(() => expect(old.uploadMedia).toHaveBeenCalled());
    const signal = vi.mocked(old.uploadMedia).mock.calls[0]![3]!;
    rerender(<ConversationActionEditor node={node('note', { text: '' })} editable transport={next} onChange={change} />);
    await act(async () => { upload.resolve(asset); });
    expect(signal.aborted).toBe(true);
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Nota interna')).toHaveValue('');
  });
  it('keeps read-only controls disabled and describes a private note without a public send action', async () => {
    const api = transport();
    render(<ConversationActionEditor node={node('note', { text: 'Anotação privada' })} editable={false} transport={api} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Nota interna')).toBeDisabled();
    expect(screen.getByText(/não é enviada ao WhatsApp/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Enviar mensagem/ })).toBeNull();
  });
  it('requires explicit reconfiguration to replace a historical marker', async () => {
    const api = transport(), change = vi.fn();
    render(<ConversationActionEditor node={node('note', { conversationEffectVersion: 1, text: 'Antiga' })} editable transport={api} onChange={change} />);
    await screen.findByRole('button', { name: 'Reconfigurar bloco' });
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconfigurar bloco' }));
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ conversationEffectVersion: 2, text: 'Antiga', operation: 'note' }));
  });
  it('shows a changed resource and updates its pinned revision only after an explicit choice', async () => {
    const api = transport(), change = vi.fn();
    render(<ConversationActionEditor node={node('tag', { resourceId: resource, resourceRevision: 'b'.repeat(64) })} editable transport={api} onChange={change} />);
    const refresh = await screen.findByRole('button', { name: 'Usar versão atual do recurso' });
    expect(change).not.toHaveBeenCalled(); fireEvent.click(refresh);
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ resourceRevision: 'a'.repeat(64) }));
  });
  it('requires an explicit selection for a newer revision of the same private asset', async () => {
    const api = transport(), change = vi.fn();
    render(<ConversationActionEditor node={node('media', { mediaEffectVersion: 2, mediaId: resource, mediaRevision: 1 })} editable transport={api} onChange={change} />);
    const refresh = await screen.findByRole('button', { name: 'Usar versão atual do arquivo' });
    expect(change).not.toHaveBeenCalled(); fireEvent.click(refresh);
    expect(change).toHaveBeenCalledWith(expect.objectContaining({ mediaId: resource, mediaRevision: 2 }));
  });
});
