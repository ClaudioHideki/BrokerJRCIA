// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChannelDeletion } from './ChannelDeletion.js';

const preview = { resourceId: 'one', resourceName: 'Comercial', kind: 'CHANNEL', canDelete: true,
  blockers: [], counts: { messages: 7, automations: 1 }, externalEffects: [], operationId: null, operationStatus: null };

it('requires the resource name and reason and never mistakes an accepted job for completed deletion', async () => {
  const request = vi.fn(async (path: string, method?: string, _body?: unknown) => method === 'POST'
    ? { operationId: 'op', status: 'CLEANING_EXTERNAL' } : path.endsWith('deletion-preview')
      ? preview : { operationId: 'op', status: 'ACTION_REQUIRED', errorCode: 'PROVIDER_FAILED', updatedAt: new Date().toISOString() });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  const submit = await screen.findByRole('button', { name: 'Confirmar exclusão definitiva' });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Digite o nome da conexão'), { target: { value: 'Comercial' } });
  fireEvent.change(screen.getByLabelText('Motivo da exclusão'), { target: { value: 'Encerramento do contrato' } });
  fireEvent.click(submit);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/one/deletion', 'POST',
    { confirmationName: 'Comercial', reason: 'Encerramento do contrato' }));
  expect(await screen.findByText('Exclusão precisa de atenção')).toBeVisible();
  expect(screen.queryByText('Conexão excluída')).not.toBeInTheDocument();
});

it('recovers an existing operation after reload without submitting another deletion', async () => {
  const request = vi.fn(async (path: string) => path.endsWith('deletion-preview')
    ? { ...preview, operationId: 'existing', operationStatus: 'CLEANING_EXTERNAL' }
    : { operationId: 'existing', status: 'ACTION_REQUIRED', errorCode: 'EVOLUTION_CLEANUP_UNVERIFIED' });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  expect(await screen.findByText('Exclusão precisa de atenção')).toBeVisible();
  expect(request).toHaveBeenCalledWith('/one/deletion/existing');
  expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
  expect(screen.getByRole('button', { name: 'Retentar exclusão segura' })).toBeDisabled();
});

it('explains the remote Flow blocker and never carries a preview across channels', async () => {
  const request = vi.fn().mockResolvedValue({ ...preview, canDelete: false, blockers: ['FLOW_REMOTE_BOT_ATTACHED'] });
  const view = render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  expect(await screen.findByText(/robô Flow vinculado/)).toBeVisible();
  view.rerender(<ChannelDeletion request={request} path="/two" />);
  expect(screen.queryByText('Excluir definitivamente Comercial')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Excluir conexão' })).toBeVisible();
});

it('shows impact blockers and refuses to submit even with a matching name', async () => {
  const request = vi.fn().mockResolvedValue({ ...preview, canDelete: false, blockers: ['PENDING_OR_UNCERTAIN_WORK'] });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  expect(await screen.findByText(/operações em andamento/i)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Digite o nome da conexão'), { target: { value: 'Comercial' } });
  fireEvent.change(screen.getByLabelText('Motivo da exclusão'), { target: { value: 'Encerramento do contrato' } });
  expect(screen.getByRole('button', { name: 'Confirmar exclusão definitiva' })).toBeDisabled();
  expect(request).toHaveBeenCalledTimes(1);
});
