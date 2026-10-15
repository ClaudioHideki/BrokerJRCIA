// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { AUTOMATION_NODE_CATALOG_V1, welcomeFlow } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
import { AutomationEditorSurface } from './AutomationStudio.js';
const org = '92776cb0-bcba-45c0-98a3-2937fefdfdaf', id = '11111111-2222-4333-8444-555555555555';
const waitId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const definition = { schemaVersion: 1, id, organizationId: org, name: 'Fluxo nativo', lifecycleStatus: 'DRAFT',
  draft: { revision: 1, graph: welcomeFlow() }, activeVersion: null, updatedAt: '2026-10-15T12:00:00.000Z' };
function mount(request: ApiClient['request'], canPublish = true) {
  return render(<MemoryRouter initialEntries={[`/automations/${id}/edit`]}><Routes><Route path="/automations/:id/edit"
    element={<AutomationEditorSurface client={{ request } as ApiClient} organizationId={org} administrator scopeKey="account3-actor9-session1"
      canPublish={canPublish} bindingPath={`/automations/${id}/bind`} />} /></Routes></MemoryRouter>);
}
afterEach(() => sessionStorage.clear());
it('refuses a definition for another organization before displaying or editing its draft', async () => {
  const request = vi.fn(async (path: string) => path === `/v1/automations/${id}`
    ? { ...definition, organizationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
    : path === '/v1/automation-nodes' ? { data: AUTOMATION_NODE_CATALOG_V1 } : { enabled: true, canEdit: true }) as ApiClient['request'];
  mount(request);
  await screen.findByText('O fluxo retornado não corresponde à empresa e à edição selecionadas.');
  expect(screen.queryByLabelText('Nome da automação')).toBeNull();
  expect(sessionStorage.length).toBe(0);
});
it('mounts the shared editor with an injected authorized client and no console session provider', async () => {
  const request = vi.fn(async (path: string) => {
    if (path === `/v1/automations/${id}`) return definition;
    if (path === '/v1/automation-nodes') return { data: AUTOMATION_NODE_CATALOG_V1 };
    if (path === '/v1/automations/status') return { enabled: true, canEdit: true, canPublish: true, reasons: [] };
    throw Error(path);
  }) as ApiClient['request'];
  mount(request);
  expect(await screen.findByLabelText('Nome da automação')).toHaveValue('Fluxo nativo');
  expect(screen.getByRole('link', { name: 'Vincular a uma caixa' })).toHaveAttribute('href', `/automations/${id}/bind`);
  expect(vi.mocked(request).mock.calls.every(([path]) => path.startsWith('/v1/automation'))).toBe(true);
});
it('does not offer publishing to a native session with edit permission only', async () => {
  const request = vi.fn(async (path: string) => path === `/v1/automations/${id}` ? definition : path === '/v1/automation-nodes'
    ? { data: AUTOMATION_NODE_CATALOG_V1 } : { enabled: true, canEdit: true, canPublish: true, reasons: [] }) as ApiClient['request'];
  mount(request, false);
  await screen.findByLabelText('Nome da automação');
  expect(screen.getByRole('button', { name: 'Salvar' })).toBeDisabled(); // Unchanged draft, not a permission denial.
  expect(screen.getByRole('button', { name: 'Publicar' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Nome da automação'), { target: { value: 'Editado' } });
  expect(screen.getByRole('button', { name: 'Salvar' })).not.toBeDisabled();
  expect(sessionStorage.getItem(`jrc-automation-draft:account3-actor9-session1:${id}`)).toContain('Editado');
});
it('sends a synthetic action outcome with the exact wait identity through the injected client', async () => {
  const bodies: Record<string, unknown>[] = [];
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === `/v1/automations/${id}`) return definition;
    if (path === '/v1/automation-nodes') return { data: AUTOMATION_NODE_CATALOG_V1 };
    if (path === '/v1/automations/status') return { enabled: true, canEdit: true, canPublish: true, reasons: [] };
    if (path.endsWith('/simulate')) {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? { status: 'WAITING', effects: [], trace: [], state: { variables: {} },
        wait: { kind: 'IO', nodeId: 'action', waitId }, actionWait: { nodeId: 'action', operation: 'note', waitId } }
        : { status: 'COMPLETED', effects: [], trace: [], state: { variables: {} } };
    }
    throw Error(path);
  }) as ApiClient['request'];
  mount(request);
  fireEvent.click(await screen.findByRole('button', { name: 'Testar' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aplicar resultado fictício' }));
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1]).toMatchObject({ events: [{ type: 'ACTION_RESPONSE', nodeId: 'action', waitId, outcome: 'success' }] });
});
