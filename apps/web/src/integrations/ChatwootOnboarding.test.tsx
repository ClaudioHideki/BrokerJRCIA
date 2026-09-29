// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatwootOnboarding } from './ChatwootOnboarding.js';

const id = '884c4ce2-741f-47a1-b9a2-ccfbcbb60231';
const operation = { operationId: id, state: 'UNKNOWN', stage: 'LINK_INBOX', instanceId: id,
  integrationId: null, inboxId: null, lastError: 'CHATWOOT_OUTCOME_UNKNOWN' };
const resources = { providers: [{ id, name: 'Engine' }], instances: [{ id, name: 'Comercial', status: 'DISCONNECTED' }], connections: [] };

it('recovers persisted operations on opening and reconciles an uncertain inbox without starting another', async () => {
  const request = vi.fn(async (path: string) => path.endsWith('/resources') ? resources
    : path.endsWith('/recover') ? { ...operation, state: 'PENDING' } : { data: [operation] });
  render(<ChatwootOnboarding request={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir configuração guiada' }));
  expect(await screen.findByText('Resultado a conferir')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Criar vínculo guiado' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Conferir e retomar' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/control/onboarding/${id}/recover`, 'POST',
    { action: 'RECONCILE' }, { idempotencyKey: expect.any(String) }));
  expect(request).not.toHaveBeenCalledWith('/control/onboarding', 'POST', expect.anything(), expect.anything());
});

it('uses the selected existing instance and reuses the creation identity after an uncertain response', async () => {
  const request = vi.fn(async (path: string, method?: string, _body?: unknown, _options?: unknown) => {
    if (method === 'POST') throw new Error('timeout');
    return path.endsWith('/resources') ? resources : { data: [] };
  });
  render(<ChatwootOnboarding request={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir configuração guiada' }));
  fireEvent.change(await screen.findByLabelText('WhatsApp para vincular'), { target: { value: id } });
  fireEvent.change(screen.getByLabelText('Nome da caixa na central'), { target: { value: 'Vendas' } });
  fireEvent.click(screen.getByRole('button', { name: 'Criar vínculo guiado' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Consultar solicitação anterior' }));
  await waitFor(() => expect(request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(2));
  const requests = request.mock.calls.filter(call => call[1] === 'POST');
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]?.[2]).toEqual({ name: 'Vendas', source: { kind: 'EXISTING', instanceId: id }, agentIds: [], replaceExistingWebhook: false });
});
