// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiWebhooksPage } from './ApiWebhooks.js';

const fixture = vi.hoisted(() => ({ role: 'OWNER', name: 'Empresa de laboratório A' }));
vi.mock('../auth/SessionProvider.js', () => ({
  useSession: () => ({ session: { activeOrganization: { id: 'company-a', name: fixture.name, role: fixture.role } } }),
}));
afterEach(() => { fixture.role = 'OWNER'; });

describe('ApiWebhooksPage', () => {
  it('opens actual public assets without SPA interception or embedded credentials', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    render(<MemoryRouter><ApiWebhooksPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'API e webhooks', level: 1 })).toBeVisible();
    const portal = screen.getByRole('link', { name: 'Abrir documentação da API' });
    expect(portal).toHaveAttribute('href', '/documentation/');
    expect(portal).not.toHaveAttribute('data-discover');
    expect(screen.getByRole('link', { name: 'Guia da API em PDF' })).toHaveAttribute('href', '/documentation/guia-api-jrc.pdf');
    expect(screen.getByRole('link', { name: 'OpenAPI de mensagens' })).toHaveAttribute('href', '/documentation/openapi-messaging.json');
    expect(screen.getByRole('link', { name: 'OpenAPI de eventos' })).toHaveAttribute('href', '/documentation/openapi-events.json');
    expect(screen.getByRole('link', { name: 'Postman de eventos' })).toHaveAttribute('href', '/documentation/postman-events.json');
    expect(screen.getByRole('link', { name: 'Gerenciar chaves de API' })).toHaveAttribute('href', '/chaves-api');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('explains the two modes and current partner limits without implying automatic host provisioning', () => {
    render(<MemoryRouter><ApiWebhooksPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Modo A — API de parceiro' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Modo B — integração direta' })).toBeVisible();
    expect(screen.getByText(/não cria automaticamente uma caixa/i)).toBeVisible();
    expect(screen.getByText(/callback HTTPS.*polling/i)).toBeVisible();
    expect(screen.getByText(/envio de mídia, grupos, templates Meta e gestão de Flows/i)).toBeVisible();
    expect(screen.getByText(/segredo de assinatura.*separado/i)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Configurar integração direta' })).toHaveAttribute('href', '/integracoes');
  });

  it.each(['OPERATOR', 'VIEWER'])('keeps documentation accessible to %s without key-management controls', (role) => {
    fixture.role = role;
    render(<MemoryRouter><ApiWebhooksPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Abrir documentação da API' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Gerenciar chaves de API' })).not.toBeInTheDocument();
    expect(screen.getByText(/proprietário ou administrador.*chave/i)).toBeVisible();
  });
});
