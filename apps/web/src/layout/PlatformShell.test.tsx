// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformShell } from './PlatformShell.js';
import type { StaffSession } from '../platform/model.js';

function session(role: StaffSession['user']['role'] = 'SUPER_ADMIN', id = 'staff-a'): StaffSession {
  return { user: { id, email: `${id}@example.test`, role }, csrfToken: 'synthetic-csrf', expiresAt: '2030-01-01T12:00:00Z' };
}
function shell(staff = session()) {
  return <MemoryRouter initialEntries={['/jrc/grupos']}><PlatformShell session={staff} busy={false} logout={vi.fn()}><h1>Conteúdo da plataforma</h1></PlatformShell></MemoryRouter>;
}
afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 }); });

describe('PlatformShell navigation', () => {
  it('searches actual platform labels and descriptions independently from tenant pages', () => {
    render(shell());
    const search = screen.getByRole('searchbox', { name: 'Buscar páginas da plataforma' });
    fireEvent.change(search, { target: { value: 'economicos' } });
    const navigation = screen.getByRole('navigation', { name: 'Administração JRC' });
    expect(within(navigation).getByRole('link', { name: 'Grupos econômicos' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getAllByRole('link')).toHaveLength(1);
    fireEvent.change(search, { target: { value: 'capacidade' } });
    expect(within(navigation).getByRole('link', { name: 'Planos e limites' })).toHaveAttribute('href', '/jrc/planos');
    fireEvent.change(search, { target: { value: 'flows' } });
    expect(within(navigation).getByRole('status')).toHaveTextContent('Nenhuma página encontrada');
    expect(within(navigation).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca da plataforma' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(within(navigation).getAllByRole('link')).toHaveLength(7);
    expect(screen.queryByRole('link', { name: /chaves de api|flows/i })).not.toBeInTheDocument();
  });

  it.each(['SUPER_ADMIN', 'SUPPORT'] as const)('keeps labeled read navigation and an accessible collapsible group for %s', (role) => {
    render(shell(session(role)));
    const toggle = screen.getByRole('button', { name: 'Plataforma' });
    const navigation = screen.getByRole('navigation', { name: 'Administração JRC' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'platform-navigation-group');
    const link = within(navigation).getByRole('link', { name: 'Empresas' });
    expect(link.querySelector('svg')).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(navigation).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(within(navigation).getByRole('link', { name: 'Empresas' })).toBeVisible();
    expect(screen.getByText('Administração da plataforma')).toBeVisible();
  });

  it('restores mobile trigger focus on Escape and link selection, then focuses the filtered first link', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(shell());
    const trigger = screen.getByRole('button', { name: 'Abrir navegação' });
    expect(screen.queryByRole('navigation', { name: 'Administração JRC' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveFocus());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'economicos' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Grupos econômicos' })).toHaveFocus());
    fireEvent.click(screen.getByRole('link', { name: 'Grupos econômicos' }));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('clears discovery state when the staff identity changes without persistent storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(shell());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'capacidade' } });
    view.rerender(shell(session('SUPPORT', 'staff-b')));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('link', { name: 'Empresas' })).toBeVisible();
    expect(screen.getByText('staff-b@example.test')).toBeVisible();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
