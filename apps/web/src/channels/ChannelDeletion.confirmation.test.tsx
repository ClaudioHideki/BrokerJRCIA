// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChannelDeletion } from './ChannelDeletion.js';
import { ApiClientError } from '../api/client.js';

const deletionReason = 'Exclusão da conexão confirmada pelo administrador no painel do Broker.';
const reconciliationReason = 'Conferência da remoção externa solicitada pelo administrador no painel do Broker.';
const preview = { resourceId: 'one', resourceName: 'Comercial', kind: 'CHANNEL', canDelete: true,
  blockers: [], counts: { messages: 7, automationBindings: 1 }, externalEffects: [], operationId: null, operationStatus: null };
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(done => { resolve = done; });
  return { promise, resolve };
};

it('confirms once with the authenticated preview name and audit reason without manual fields', async () => {
  const request = vi.fn(async (path: string, method?: string) => method === 'POST'
    ? { operationId: 'op', status: 'CLEANING_EXTERNAL' } : path.endsWith('deletion-preview')
      ? preview : { operationId: 'op', status: 'ACTION_REQUIRED', errorCode: 'PROVIDER_FAILED' });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  const submit = await screen.findByRole('button', { name: 'Confirmar exclusão definitiva' });
  expect(screen.getByRole('heading', { name: 'Excluir definitivamente Comercial' })).toBeVisible();
  expect(screen.getByText('Mensagens no Broker')).toBeVisible();
  expect(screen.getByText('7')).toBeVisible();
  expect(screen.getByText(/caixas, contas e conversas.*preservados/i)).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(submit).toBeEnabled();
  expect(request.mock.calls.some(call => call[1] === 'POST')).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/one/deletion', 'POST',
    { confirmationName: 'Comercial', reason: deletionReason }));
  expect(await screen.findByText('Exclusão precisa de atenção')).toBeVisible();
  expect(screen.queryByText('Conexão excluída')).not.toBeInTheDocument();
});

it('cancels the impact preview without sending a deletion request', async () => {
  const request = vi.fn().mockResolvedValue(preview);
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
  expect(screen.getByRole('button', { name: 'Excluir conexão' })).toBeVisible();
  expect(request).toHaveBeenCalledTimes(1);
});

it('reconciles uncertain cleanup without a manual reason or a second deletion', async () => {
  const request = vi.fn(async (path: string, method?: string) => path.endsWith('deletion-preview')
    ? { ...preview, operationId: 'existing', operationStatus: 'ACTION_REQUIRED' }
    : method === 'POST' ? { operationId: 'existing', status: 'REQUESTED' }
      : { operationId: 'existing', status: 'ACTION_REQUIRED', errorCode: 'EVOLUTION_CLEANUP_UNVERIFIED' });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  const reconcile = await screen.findByRole('button', { name: 'Conferir remoção externa' });
  expect(screen.getByRole('button', { name: 'Retentar exclusão segura' })).toBeDisabled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(reconcile);
  await waitFor(() => expect(request).toHaveBeenCalledWith('/one/deletion/existing/reconcile', 'POST', { reason: reconciliationReason }));
  expect(request.mock.calls.some(call => call[0] === '/one/deletion')).toBe(false);
});

it('does not offer a retry before reading the existing ACTION_REQUIRED error', async () => {
  const status = deferred();
  const request = vi.fn(async (path: string) => path.endsWith('deletion-preview')
    ? { ...preview, operationId: 'existing', operationStatus: 'ACTION_REQUIRED' } : status.promise);
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  const retry = await screen.findByRole('button', { name: 'Retentar exclusão segura' });
  expect(retry).toBeDisabled();
  await act(async () => { status.resolve({ operationId: 'existing', status: 'ACTION_REQUIRED', errorCode: 'EVOLUTION_CLEANUP_UNVERIFIED' }); });
  expect(retry).toBeDisabled();
});

it('keeps a lost deletion response fenced even when the next preview has no receipt yet', async () => {
  const request = vi.fn(async (_path: string, method?: string) => {
    if (method === 'POST') throw new Error('Response lost');
    return preview;
  });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  fireEvent.submit((await screen.findByRole('button', { name: 'Confirmar exclusão definitiva' })).closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent(/não foi confirmada/i);
  expect(screen.getByRole('button', { name: 'Confirmar exclusão definitiva' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Conferir solicitação' }));
  await waitFor(() => expect(request.mock.calls.filter(call => call[0] === '/one/deletion-preview')).toHaveLength(2));
  const submit = screen.getByRole('button', { name: 'Confirmar exclusão definitiva' });
  expect(submit).toBeDisabled();
  fireEvent.submit(submit.closest('form')!);
  expect(request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});

it('blocks rapid duplicate submits and completes only once after server proof', async () => {
  const post = deferred(), onCompleted = vi.fn();
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? post.promise : preview);
  render(<ChannelDeletion request={request} path="/one" onCompleted={onCompleted} />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  const submit = await screen.findByRole('button', { name: 'Confirmar exclusão definitiva' });
  fireEvent.submit(submit.closest('form')!);
  fireEvent.submit(submit.closest('form')!);
  expect(request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
  expect(onCompleted).not.toHaveBeenCalled();
  await act(async () => { post.resolve({ operationId: 'op', status: 'COMPLETED' }); });
  expect(await screen.findByText('Conexão excluída')).toBeVisible();
  expect(onCompleted).toHaveBeenCalledTimes(1);
});

it('requires a fresh impact preview after an explicit server rejection instead of trapping a rejected request as uncertain', async () => {
  let reads = 0;
  const request = vi.fn(async (_path: string, method?: string) => {
    if (method === 'POST') throw new ApiClientError('Há uma operação em andamento', 409, undefined, 'LIFECYCLE_PENDING_WORK');
    return ++reads === 1 ? preview : { ...preview, canDelete: false, blockers: ['PENDING_OR_UNCERTAIN_WORK'] };
  });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirmar exclusão definitiva' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  expect(await screen.findByText(/operações em andamento/i)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Confirmar exclusão definitiva' })).toBeDisabled();
  expect(request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});

it('ignores a late preview after tenant scope changes without changing the relative path', async () => {
  const old = deferred(), request = vi.fn(() => old.promise), replacement = vi.fn().mockResolvedValue(preview);
  const view = render(<ChannelDeletion request={request} path="/one" scopeKey="tenant-a:1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  view.rerender(<ChannelDeletion request={replacement} path="/one" scopeKey="tenant-b:2" />);
  await act(async () => { old.resolve(preview); });
  expect(screen.queryByText('Excluir definitivamente Comercial')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Excluir conexão' })).toBeVisible();
  expect(replacement).not.toHaveBeenCalled();
});

it('does not invoke completion or poll a new tenant after a late POST response', async () => {
  const post = deferred(), onCompleted = vi.fn(), replacementCompleted = vi.fn();
  const request = vi.fn(async (_path: string, method?: string) => method === 'POST' ? post.promise : preview);
  const replacement = vi.fn().mockResolvedValue(preview);
  const view = render(<ChannelDeletion request={request} path="/one" scopeKey="tenant-a:1" onCompleted={onCompleted} />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  fireEvent.submit((await screen.findByRole('button', { name: 'Confirmar exclusão definitiva' })).closest('form')!);
  view.rerender(<ChannelDeletion request={replacement} path="/one" scopeKey="tenant-b:2" onCompleted={replacementCompleted} />);
  await act(async () => { post.resolve({ operationId: 'op', status: 'COMPLETED' }); });
  expect(onCompleted).not.toHaveBeenCalled();
  expect(replacementCompleted).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  expect(screen.queryByText('Conexão excluída')).not.toBeInTheDocument();
});

it('rejects an impact preview for another resource', async () => {
  const request = vi.fn().mockResolvedValue({ ...preview, resourceId: 'other' });
  render(<ChannelDeletion request={request} path="/one" />);
  fireEvent.click(screen.getByRole('button', { name: 'Excluir conexão' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/conferir o impacto/i);
  expect(screen.queryByRole('button', { name: 'Confirmar exclusão definitiva' })).not.toBeInTheDocument();
});
