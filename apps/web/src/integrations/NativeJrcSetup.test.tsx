// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NativeJrcSetup } from './NativeJrcSetup.js';

afterEach(cleanup);
const binding = { organizationId: '81555d45-b1a2-4a3f-ab95-c1459b0df0d0', accountId: 3, destinationRevision: 1 };
const secret = 'jrc_synthetic_testOnly';
const issued = { id: binding.organizationId, secret, binding, scopes: ['chatwoot:read'], expiresAt: null };

it('issues an account-limited key and shows the native setup links without a conversation', async () => {
  const request = vi.fn().mockResolvedValue(issued);
  render(<NativeJrcSetup request={request} accountId={3} baseUrl="https://conversas.example.test" />);
  fireEvent.click(screen.getByRole('button', { name: 'Emitir chave para o módulo JRC' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/control-credentials', 'POST', {
    name: 'Módulo JRC Conversas — conta 3',
    scopes: ['chatwoot:read', 'chatwoot:manage', 'chatwoot:pair', 'chatwoot:disconnect'], expiresAt: null,
  }, { idempotencyKey: expect.any(String) }));
  expect(await screen.findByLabelText('Chave de controle da conta')).toHaveValue(secret);
  expect(screen.getByLabelText('ID da empresa no Broker')).toHaveValue(binding.organizationId);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole('button', { name: 'Copiar chave' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(secret));
  expect(screen.getByRole('link', { name: 'Abrir central de atendimento' })).toHaveAttribute('href', 'https://conversas.example.test/app/accounts/3');
  fireEvent.click(screen.getByRole('button', { name: 'Fechar e apagar chave desta tela' }));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
});

it('keeps the same request identity after an uncertain response instead of issuing another key silently', async () => {
  const request = vi.fn().mockRejectedValue(new Error('network'));
  render(<NativeJrcSetup request={request} accountId={3} baseUrl="https://conversas.example.test" />);
  fireEvent.click(screen.getByRole('button', { name: 'Emitir chave para o módulo JRC' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Repetir consulta da emissão' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[0]![3]).toEqual(request.mock.calls[1]![3]);
  expect(screen.queryByLabelText('Chave de controle da conta')).not.toBeInTheDocument();
});
