// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { welcomeFlow } from '@jrc/contracts';
import { SetupRobot } from './SetupRobot.js';
const org = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
const bundle = { id, organizationId: org, revision: 1, rootKey: 'root', rootId: id, state: 'DRAFT',
  flows: [{ id, key: 'root', name: 'Robô de suporte' }], requirements: [], publications: {} };
it('maps private package drafts explicitly without activating the inbox', async () => {
  const action = vi.fn(async () => ({})), row: any = { id, organizationId: org, selection: { transport: 'QR', packageId: id, automationId: id } };
  const client = { request: vi.fn(async (path: string) => path === '/v1/automations' ? { data: [], nextCursor: null }
    : path.endsWith('/versions') ? { data: [] } : bundle) } as unknown as ApiClient;
  render(<MemoryRouter><SetupRobot client={client} row={row} disabled={false} save={vi.fn()} action={action} /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Aplicar caixa e destino humano aos rascunhos' }));
  await waitFor(() => expect(action).toHaveBeenCalledWith('package-bindings'));
});
it('exports the selected published version as a portable package', async () => {
  const timestamp = '2026-11-09T12:00:00.000Z', download = vi.fn(), revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = download.mockReturnValue('blob:package'); static override revokeObjectURL = revoke; });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const row: any = { id, organizationId: org, selection: { transport: 'QR', automationId: id, version: 1 } };
  const request = vi.fn(async (path: string) => path === '/v1/automations' ? { data: [{ schemaVersion: 1, id, organizationId: org, name: 'Robô', lifecycleStatus: 'PUBLISHED', activeVersion: 1, draft: { revision: 1, graph: welcomeFlow() }, updatedAt: timestamp }], nextCursor: null }
    : path.endsWith('/versions') ? { data: [{ schemaVersion: 1, automationId: id, organizationId: org, version: 1, graph: welcomeFlow(), checksum: 'a'.repeat(64), publishedAt: timestamp }] }
    : { format: 'jrc-broker-package/1', rootKey: 'root', flows: [{ key: 'root', name: 'Robô', graph: welcomeFlow() }] });
  render(<MemoryRouter><SetupRobot client={{ request } as unknown as ApiClient} row={row} disabled={false} save={vi.fn()} /></MemoryRouter>);
  const button = await screen.findByRole('button', { name: 'Exportar pacote portátil' });
  await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/v1/automations/${id}/package?version=1`));
  await waitFor(() => expect(download).toHaveBeenCalledOnce()); expect(revoke).toHaveBeenCalledWith('blob:package');
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
