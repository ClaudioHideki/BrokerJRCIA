// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vitest';

import type { ConsoleSessionResponse } from '@jrc/contracts';

import type { ApiClient } from '../api/client.js';
import { App } from './App.js';

const session: ConsoleSessionResponse = {
  accessToken: 'access-canary-memory-only',
  tokenType: 'Bearer',
  expiresIn: 600,
  user: { id: '8e757fb4-18ff-4c20-841b-19f282ece546', email: 'owner@example.test' },
  activeOrganization: {
    id: '92776cb0-bcba-45c0-98a3-2937fefdfdaf',
    name: 'JRC Matriz',
    slug: 'jrc-matriz',
    role: 'OWNER',
  },
  organizations: [{
    id: '92776cb0-bcba-45c0-98a3-2937fefdfdaf',
    name: 'JRC Matriz',
    slug: 'jrc-matriz',
    role: 'OWNER',
  }],
};

function client(): ApiClient {
  return {
    login: vi.fn(async () => ({
      organizations: session.organizations,
      selectionToken: 'S'.repeat(43),
      expiresAt: '2030-01-01T12:05:00.000Z',
    })),
    selectOrganization: vi.fn(async () => session),
    restore: vi.fn(async () => session),
    switchOrganization: vi.fn(async () => session),
    logout: vi.fn(async () => undefined),
    async request<T>() { return {} as T; },
    registerTenantPurge: vi.fn(() => () => undefined),
    subscribeToSessionExpiration: vi.fn(() => () => undefined),
  };
}

describe('Console JRC', () => {
  it('orienta a equipe para o login administrativo separado', async () => {
    const anonymous = client();
    anonymous.restore = vi.fn(async () => { throw new Error('Sem sessão'); });
    render(<App client={anonymous} initialEntries={['/login']} />);
    expect(await screen.findByRole('link', { name: 'Acessar administração JRC' })).toHaveAttribute('href', '/jrc');
  });
  it('renderiza shell, identidade, organização e papel ativos', async () => {
    const { container } = render(<App client={client()} initialEntries={['/conexoes']} />);

    expect(await screen.findByRole('heading', { name: 'Conexões' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'JRC PABX' })).toHaveAttribute(
      'src',
      '/brand/logo-jrc-2024.png',
    );
    expect(screen.getByLabelText('Organização ativa')).toHaveValue(session.activeOrganization.id);
    expect(screen.getByText('Proprietário')).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
    const appRoot = container.querySelector<HTMLElement>('.jrc-app');
    expect(appRoot?.style.getPropertyValue('--jrc-primary')).toBe('#007392');
    expect(appRoot?.style.getPropertyValue('--jrc-font-family-sans')).toContain('Inter');
    expect(appRoot?.style.getPropertyValue('--jrc-radius-lg')).toBe('0.75rem');
    expect(appRoot?.style.getPropertyValue('--jrc-shadow-lg')).toBe('0 16px 40px rgb(21 50 67 / 12%)');
  });

  it('não persiste estado de autenticação e não coloca token no DOM', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    render(<App client={client()} initialEntries={['/conexoes']} />);
    await screen.findByRole('heading', { name: 'Conexões' });

    // React Router may read its own view-transition preference. The console
    // must never write authentication state or use a sensitive storage key.
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    for (const call of getItem.mock.calls) {
      expect(String(call[0])).not.toMatch(/access|refresh|selection|token|session/i);
    }
    expect(document.body.textContent).not.toContain(session.accessToken);
    expect(window.location.href).not.toContain(session.accessToken);
    vi.restoreAllMocks();
  });

  it('não apresenta violações automáticas de acessibilidade no shell desktop', async () => {
    const { container } = render(<App client={client()} initialEntries={['/conexoes']} />);
    await screen.findByRole('heading', { name: 'Conexões' });
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });

  it('mantém o controle mobile semanticamente expansível', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    render(<App client={client()} initialEntries={['/conexoes']} />);
    const menu = await screen.findByRole('button', { name: 'Abrir navegação' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Navegação principal' })).not.toBeInTheDocument();
    menu.click();
    await waitFor(() => expect(menu).toHaveAttribute('aria-expanded', 'true'));
    expect(menu).toHaveAccessibleName('Fechar navegação');
    expect(screen.getByRole('navigation', { name: 'Navegação principal' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(menu).toHaveAttribute('aria-expanded', 'false'));
    expect(menu).toHaveFocus();

    fireEvent.click(menu);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveFocus());
    fireEvent.click(screen.getByRole('link', { name: 'Chaves de API' }));
    expect(await screen.findByRole('heading', { name: 'Chaves de API' })).toBeVisible();
    await waitFor(() => expect(menu).toHaveAttribute('aria-expanded', 'false'));
    expect(menu).toHaveFocus();
  });
});
