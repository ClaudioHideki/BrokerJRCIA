// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client.js';
import { CompanyWorkspace } from './CompanyWorkspace.js';
import type { IntegrationRequest } from '../integrations/ChatwootPanel.js';

const member = { userId: 'user-a', email: 'person@example.test', role: 'OWNER', status: 'ACTIVE' };
const preview = {
  userId: member.userId, email: member.email, status: 'ACTIVE', confirmationToken: 'preview-token',
  organizations: [
    { id: 'org-a', name: 'Empresa A', role: 'OWNER', status: 'ACTIVE', membershipStatus: 'ACTIVE' },
    { id: 'org-b', name: 'Empresa B desativada', role: 'VIEWER', status: 'DISABLED', membershipStatus: 'DISABLED' },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function workspace(request: IntegrationRequest, admin = true, id = 'org-a', disabled = false) {
  return <CompanyWorkspace key={id}
    company={{ id, name: 'Empresa A', slug: 'empresa-a', status: 'ACTIVE', plan: 'Inicial' }}
    members={[member]} monitor={null} loading={false} admin={admin} disabled={disabled} defaultTab="users"
    saveCompany={vi.fn()} saveMember={vi.fn()} acknowledge={vi.fn()} refresh={vi.fn()}
    passwordResetRequest={request} />;
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: `Redefinir senha de ${member.email}` }));
  return screen.findByRole('dialog', { name: 'Redefinir senha global' });
}
async function fill(password = 'synthetic-password') {
  fireEvent.change(await screen.findByLabelText('Confirme o e-mail do usuário'), { target: { value: member.email } });
  fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Repita a nova senha'), { target: { value: password } });
}
afterEach(() => vi.restoreAllMocks());

describe('global user password reset', () => {
  it('previews the global identity and every company, including disabled memberships and companies', async () => {
    const request = vi.fn().mockResolvedValue(preview);
    render(workspace(request));
    const dialog = await open();
    expect(await within(dialog).findByText('Empresa B desativada')).toBeVisible();
    expect(within(dialog).getByText('ID do usuário: user-a')).toBeVisible();
    expect(within(dialog).getByText(/senha é global/i)).toBeVisible();
    expect(within(dialog).getByText(/sessões.*todas as empresas/i)).toBeVisible();
    expect(within(dialog).getByText('Desativada')).toBeVisible();
    expect(within(dialog).getByText('Desativado')).toBeVisible();
    expect(request).toHaveBeenCalledExactlyOnceWith('/users/user-a/password-reset-preview');
  });

  it('does not expose the action to support or when the admin action is disabled', () => {
    const request = vi.fn();
    const view = render(workspace(request, false));
    expect(screen.queryByRole('button', { name: /Redefinir senha de/ })).not.toBeInTheDocument();
    view.rerender(workspace(request, true, 'org-a', true));
    expect(screen.getByRole('button', { name: /Redefinir senha de/ })).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('requires the exact confirmed email, matching passwords, and the existing 12–256 character policy', async () => {
    const request = vi.fn().mockResolvedValue(preview);
    render(workspace(request)); await open(); await fill('too-short');
    const submit = screen.getByRole('button', { name: 'Confirmar redefinição global' });
    expect(submit).toBeDisabled();
    await fill('x'.repeat(257)); expect(submit).toBeDisabled();
    await fill('x'.repeat(12)); expect(submit).toBeEnabled();
    await fill('x'.repeat(256)); expect(submit).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Repita a nova senha'), { target: { value: 'different-password' } });
    expect(submit).toBeDisabled();
    await fill();
    fireEvent.change(screen.getByLabelText('Confirme o e-mail do usuário'), { target: { value: 'other@example.test' } });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('submits the preview token once, clears sensitive fields immediately, and reports verified success', async () => {
    const result = deferred<unknown>();
    const request = vi.fn().mockResolvedValueOnce(preview).mockReturnValueOnce(result.promise);
    const local = vi.spyOn(Storage.prototype, 'setItem');
    render(workspace(request)); await open(); await fill();
    const form = screen.getByRole('button', { name: 'Confirmar redefinição global' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith('/users/user-a/password-reset', 'POST', {
      password: 'synthetic-password', confirmationEmail: member.email, confirmationToken: 'preview-token',
    });
    expect(screen.getByLabelText('Nova senha')).toHaveValue('');
    expect(screen.getByLabelText('Repita a nova senha')).toHaveValue('');
    expect(local).not.toHaveBeenCalled();
    await act(async () => result.resolve({ ok: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Senha redefinida');
    expect(screen.getByRole('status')).not.toHaveTextContent('synthetic-password');
  });

  it('clears the form on cancel and restores focus; reopening starts with a fresh preview', async () => {
    const request = vi.fn().mockResolvedValue(preview);
    render(workspace(request));
    const trigger = screen.getByRole('button', { name: /Redefinir senha de/ });
    trigger.focus(); await open(); await fill();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await open(); await screen.findByLabelText('Nova senha');
    expect(screen.getByLabelText('Nova senha')).toHaveValue('');
    expect(screen.getByLabelText('Repita a nova senha')).toHaveValue('');
    expect(screen.getByLabelText('Confirme o e-mail do usuário')).toHaveValue('');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ignores preview responses from a dismissed dialog', async () => {
    const old = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(preview);
    render(workspace(request)); await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await open(); await screen.findByLabelText('Nova senha');
    await act(async () => old.resolve({ ...preview, email: 'stale@example.test' }));
    expect(screen.queryByText('stale@example.test')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Nova senha')).toHaveValue('');
  });

  it('clears the dialog on tab changes, company changes, and loss of superadmin access', async () => {
    const request = vi.fn().mockResolvedValue(preview);
    const view = render(workspace(request)); await open(); await fill();
    fireEvent.click(screen.getByRole('tab', { name: 'Visão geral' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await open(); await fill();
    view.rerender(workspace(request, true, 'org-b'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await open(); await fill();
    view.rerender(workspace(request, false, 'org-b'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['PASSWORD_RESET_PREVIEW_CHANGED', 'PASSWORD_RESET_PREVIEW_EXPIRED'])(
    'requires a new preview and clears the password after %s', async code => {
      const request = vi.fn().mockResolvedValueOnce(preview)
        .mockRejectedValueOnce(new ApiClientError('never render server detail', 409, undefined, code))
        .mockResolvedValueOnce({ ...preview, confirmationToken: 'new-preview-token' });
      render(workspace(request)); await open(); await fill();
      fireEvent.submit(screen.getByRole('button', { name: 'Confirmar redefinição global' }).closest('form')!);
      expect(await screen.findByRole('alert')).toHaveTextContent(/prévia.*(alterada|expirada)/i);
      expect(screen.queryByLabelText('Nova senha')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).not.toHaveTextContent('never render server detail');
      fireEvent.click(screen.getByRole('button', { name: 'Consultar prévia novamente' }));
      expect(await screen.findByLabelText('Nova senha')).toHaveValue('');
      expect(screen.getByLabelText('Confirme o e-mail do usuário')).toHaveValue('');
    },
  );

  it('does not claim success or replay after an uncertain response', async () => {
    const request = vi.fn().mockResolvedValueOnce(preview).mockRejectedValueOnce(new Error('synthetic-password'));
    render(workspace(request)); await open(); await fill();
    fireEvent.submit(screen.getByRole('button', { name: 'Confirmar redefinição global' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/resultado.*não.*confirmado/i);
    expect(screen.getByRole('alert')).not.toHaveTextContent('synthetic-password');
    expect(screen.queryByLabelText('Nova senha')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects a preview for another user rather than enabling a reset', async () => {
    const request = vi.fn().mockResolvedValue({ ...preview, userId: 'other-user' });
    render(workspace(request)); await open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível.*prévia/i);
    expect(screen.queryByLabelText('Nova senha')).not.toBeInTheDocument();
  });

  it('keeps keyboard focus inside the dialog and supports Escape while the preview is loading', async () => {
    const pending = deferred<unknown>();
    const request = vi.fn().mockReturnValue(pending.promise);
    render(workspace(request));
    const trigger = screen.getByRole('button', { name: /Redefinir senha de/ }); trigger.focus();
    await open();
    expect(screen.getByRole('heading', { name: 'Redefinir senha global' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    await act(async () => pending.resolve(preview));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores the first effect response when StrictMode remounts the dialog', async () => {
    const first = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(preview);
    render(<StrictMode>{workspace(request)}</StrictMode>);
    await open(); await screen.findByLabelText('Nova senha');
    await act(async () => first.resolve({ ...preview, email: 'stale@example.test' }));
    expect(screen.queryByText('stale@example.test')).not.toBeInTheDocument();
    await fill();
    expect(screen.getByRole('button', { name: 'Confirmar redefinição global' })).toBeEnabled();
  });

  it('rejects malformed success responses and never shows an unverified success', async () => {
    const request = vi.fn().mockResolvedValueOnce(preview).mockResolvedValueOnce({ ok: false });
    render(workspace(request)); await open(); await fill();
    fireEvent.submit(screen.getByRole('button', { name: 'Confirmar redefinição global' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent(/resultado.*não.*confirmado/i);
    expect(screen.queryByText(/Senha redefinida/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Nova senha')).not.toBeInTheDocument();
  });

  it('ignores a late successful mutation after dismissal and company navigation', async () => {
    const result = deferred<unknown>();
    const request = vi.fn().mockResolvedValueOnce(preview).mockReturnValueOnce(result.promise);
    const view = render(workspace(request)); await open(); await fill();
    fireEvent.submit(screen.getByRole('button', { name: 'Confirmar redefinição global' }).closest('form')!);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    view.rerender(workspace(request, true, 'org-b'));
    await act(async () => result.resolve({ ok: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Senha redefinida/)).not.toBeInTheDocument();
  });
});
