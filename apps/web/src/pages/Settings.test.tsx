// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './Settings.js';

const fixture = vi.hoisted(() => ({
  organization: { id: 'company-a', name: 'Empresa de laboratório A', role: 'OWNER' },
  tenantRevision: 1,
}));
vi.mock('../auth/SessionProvider.js', () => ({
  useSession: () => ({ session: { activeOrganization: fixture.organization }, tenantRevision: fixture.tenantRevision }),
}));
afterEach(() => {
  fixture.organization = { id: 'company-a', name: 'Empresa de laboratório A', role: 'OWNER' };
  fixture.tenantRevision = 1;
});

describe('SettingsPage', () => {
  it('directs administrators to existing settings with explicit company and deployment scope', () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();
    expect(screen.getByText('Empresa de laboratório A')).toBeVisible();
    expect(screen.getByText('Proprietário')).toBeVisible();
    expect(screen.getByRole('link', { name: /Minha empresa/ })).toHaveAttribute('href', '/minha-empresa');
    expect(screen.getByRole('link', { name: /Chaves de API/ })).toHaveAttribute('href', '/chaves-api');
    expect(screen.getByText('Plataforma e deployment:').closest('p')).toHaveTextContent(/reinício.*servidor/i);
    expect(screen.queryByRole('button', { name: /salvar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Configurações' })).not.toBeInTheDocument();
  });

  it('lets readers find their existing read surfaces without advertising key management', () => {
    fixture.organization.role = 'VIEWER';
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /Chaves de API/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar páginas e configurações' }), { target: { value: 'credenciais' } });
    expect(screen.getByRole('link', { name: /Credenciais/ })).toHaveAttribute('href', '/credentials');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar páginas e configurações' }), { target: { value: 'pagina-inexistente-xyz' } });
    expect(screen.getByRole('status')).toHaveTextContent('Nenhuma página encontrada');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('clears the previous company search when the active company changes', () => {
    const view = render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'credenciais' } });
    fixture.organization = { id: 'company-b', name: 'Empresa de laboratório B', role: 'VIEWER' };
    fixture.tenantRevision = 2;
    view.rerender(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.queryByText('Empresa de laboratório A')).not.toBeInTheDocument();
    expect(screen.getByText('Empresa de laboratório B')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Chaves de API/ })).not.toBeInTheDocument();
  });
});
