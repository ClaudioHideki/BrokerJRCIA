// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ChatwootControlPanel } from './ChatwootControlPanel.js';
const id = '884c4ce2-741f-47a1-b9a2-ccfbcbb60231', userId = '225dc92a-e1a5-4bfc-a4c5-f969cc5217d0';
const health = { integrationId: id, instanceId: id, inboxId: 31, integrationStatus: 'READY', instanceStatus: 'CONNECTED',
  transportStatus: 'UNVERIFIED', identityStatus: 'CONFIRMATION_REQUIRED', identityApproved: false, identityRevision: 3,
  observedNumberSuffix: '0100', checkedAt: new Date().toISOString(), lastError: null, callbackVerifiedAt: null,
  lastSuccessfulInboundAt: null, lastSuccessfulOutboundAt: null, allowedActions: ['status', 'pair', 'manage'] };
const members = { members: [{ userId, email: 'operator@example.test', role: 'VIEWER' }], grants: [{ userId, canPair: true }] };
it('shows health, requires identity confirmation and manages explicit grants outside an iframe', async () => {
  const request = vi.fn(async (path: string, method?: string) => {
    if (method === 'POST' || method === 'PUT') return { ok: true };
    return path.endsWith('/status') ? health : members;
  });
  render(<ChatwootControlPanel request={request} canManage connections={[{ id, name: 'Atendimento' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir controle de conexões' }));
  expect(await screen.findByText(/Final observado: 0100/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Aprovar identidade observada' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Conferi o número e autorizo esta identidade'));
  fireEvent.click(screen.getByRole('button', { name: 'Aprovar identidade observada' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/control/connections/${id}/confirm-identity`, 'POST', { observedRevision: 3 }, { idempotencyKey: expect.any(String) }));
  fireEvent.click(screen.getByLabelText('Acesso de operator@example.test'));
  fireEvent.click(screen.getByRole('button', { name: 'Salvar permissões' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(`/connections/${id}/operator-grants`, 'PUT', { grants: [] }, { idempotencyKey: expect.any(String) }));
});
it('does not offer management or legacy instance access to a delegated viewer', async () => {
  const request = vi.fn().mockResolvedValue({ ...health, allowedActions: ['status'], identityStatus: 'CONFIRMED', identityApproved: true });
  render(<ChatwootControlPanel request={request} canManage={false} connections={[{ id, name: 'Atendimento' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir controle de conexões' }));
  expect(await screen.findByText(/Sessão WhatsApp: CONNECTED/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Conectar ou reconectar' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Salvar permissões' })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(1);
});
it('discards a late pairing result when a newer health response revokes pairing', async () => {
  let resolvePair!: (value: unknown) => void; let canPair = true;
  const request = vi.fn(async (path: string) => path.endsWith('/pair') ? new Promise(resolve => { resolvePair = resolve; }) :
    { ...health, instanceStatus: 'DISCONNECTED', allowedActions: canPair ? ['status', 'pair'] : ['status'] });
  render(<ChatwootControlPanel request={request} canManage={false} connections={[{ id, name: 'Atendimento' }]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir controle de conexões' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Conectar ou reconectar' }));
  await waitFor(() => expect(resolvePair).toBeTypeOf('function'));
  canPair = false; fireEvent.click(screen.getByRole('button', { name: 'Conferir estado' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Conectar ou reconectar' })).not.toBeInTheDocument());
  await act(async () => resolvePair({ instance: { id, organizationId: id, providerAccountId: id, provider: 'BAILEYS', name: 'Synthetic', status: 'AWAITING_ACTION',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, operationId: userId, pending: false, replayed: false, reconciliationRequired: false,
    action: { type: 'PAIRING_CODE', code: 'SYNTHETIC-LATE-ONLY', expiresAt: new Date(Date.now() + 30000).toISOString() } }));
  expect(screen.queryByText('SYNTHETIC-LATE-ONLY')).not.toBeInTheDocument();
});
