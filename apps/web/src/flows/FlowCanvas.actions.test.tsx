// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { AUTOMATION_NODE_CATALOG_V1, type FlowGraph } from '@jrc/contracts';
import type { ConversationActionTransport } from '../automations/conversation-api.js';
import { FlowCanvas } from './FlowCanvas.js';
const org = '11111111-2222-4333-8444-555555555555', root = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const channel = '12345678-1234-4234-8234-123456789abc';
const supported = { state: 'SUPPORTED' as const, reason: null };
const transport: ConversationActionTransport = {
  organizationId: org, rootAutomationId: root, listChannels: async () => [{ id: channel, name: 'Caixa autorizada' }],
  actionCatalog: async () => ({ schemaVersion: 1, scope: { organizationId: org, rootAutomationId: root, channelId: channel },
    profile: 'STANDALONE', capabilities: { tag: supported, attribute: supported, note: supported, resolve: supported, media: supported }, data: [], nextCursor: null }),
  mediaCatalog: async () => [], saveResource: vi.fn(), uploadMedia: vi.fn(), revokeMedia: vi.fn(),
};
function editor(observe: (graph: FlowGraph) => void) {
  return function Editor() {
    const [graph, setGraph] = useState<FlowGraph>({ nodes: [
      { id: 'start', type: 'start', label: 'Início', position: { x: 0, y: 0 }, data: {} },
      { id: 'end', type: 'end', label: 'Fim', position: { x: 300, y: 0 }, data: {} },
    ], edges: [] });
    observe(graph);
    return <FlowCanvas graph={graph} editable onChange={setGraph} catalog={AUTOMATION_NODE_CATALOG_V1}
      actionContext={{ transport }} />;
  };
}
it('creates a version2 private note by choosing a named authorized box', async () => {
  let graph!: FlowGraph;
  const Editor = editor(value => { graph = value; }); render(<Editor />);
  fireEvent.click(screen.getByRole('button', { name: /^Nota interna/ }));
  const note = graph.nodes.find(item => item.type === 'note')!;
  expect(note.data).toMatchObject({ conversationEffectVersion: 2, operation: 'note' });
  await screen.findByRole('option', { name: 'Caixa autorizada' });
  fireEvent.change(screen.getByLabelText('Caixa da ação'), { target: { value: channel } });
  fireEvent.change(screen.getByLabelText('Nota interna'), { target: { value: 'Anotação privada' } });
  expect(graph.nodes.find(item => item.type === 'note')!.data).toMatchObject({ channelId: channel, text: 'Anotação privada', conversationEffectVersion: 2 });
  expect(screen.queryByLabelText('Destino Resultado desconhecido')).toBeNull();
  expect(screen.getByLabelText('Destino Sucesso')).toBeVisible();
});
it('creates resolve as a terminal node without a next-message connector', async () => {
  let graph!: FlowGraph;
  const Editor = editor(value => { graph = value; }); render(<Editor />);
  fireEvent.click(screen.getByRole('button', { name: /^Resolver e encerrar/ }));
  expect(graph.nodes.find(item => item.type === 'resolve')!.data).toMatchObject({ conversationEffectVersion: 2, operation: 'resolve', status: 'RESOLVED' });
  expect(screen.queryByLabelText('Destino Sucesso')).toBeNull();
  expect(screen.queryByRole('button', { name: /Conectar Resolver.*Continuar/ })).toBeNull();
  expect(screen.getByText(/termina o ciclo.*Nenhuma próxima mensagem/i)).toBeVisible();
});
