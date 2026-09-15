// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE } from '@jrc/contracts';

import type { ApiClient } from '../api/client.js';
import { ApiClientError } from '../api/client.js';
import { App } from '../app/App.js';

const ORG = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const ORG_B = '11111111-2222-4333-8444-555555555555';
const ACCOUNT = '6fd7933a-80b7-4491-b081-a0fa8c2414d2';
const ACCOUNT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const INSTANCE = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const INSTANCE_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const now = '2030-01-01T12:00:00.000Z';

function session(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'OWNER') {
  const activeOrganization = { id: ORG, name: 'JRC Matriz', slug: 'jrc-matriz', role };
  return {
    accessToken: 'memory-only-canary', tokenType: 'Bearer' as const, expiresIn: 600,
    user: { id: '8e757fb4-18ff-4c20-841b-19f282ece546', email: 'owner@example.test' },
    activeOrganization, organizations: [activeOrganization],
  };
}

function appClient(request: ApiClient['request'], role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'OWNER'): ApiClient {
  return {
    restore: vi.fn(async () => session(role)), request,
    login: vi.fn(), selectOrganization: vi.fn(), switchOrganization: vi.fn(), logout: vi.fn(),
    registerTenantPurge: vi.fn(() => () => undefined),
    subscribeToSessionExpiration: vi.fn(() => () => undefined),
  } as unknown as ApiClient;
}

function switchingAppClient(
  request: ApiClient['request'],
  options: { rejectSwitch?: boolean } = {},
): ApiClient {
  const organizations = [
    { id: ORG, name: 'JRC Matriz', slug: 'jrc-matriz', role: 'OWNER' as const },
    { id: ORG_B, name: 'JRC Filial', slug: 'jrc-filial', role: 'OWNER' as const },
  ];
  const purgeHandlers = new Set<() => void>();
  const browserSession = (activeOrganization: typeof organizations[number]) => ({
    user: { id: '8e757fb4-18ff-4c20-841b-19f282ece546', email: 'owner@example.test' },
    activeOrganization,
    organizations,
  });
  return {
    restore: vi.fn(async () => browserSession(organizations[0]!)),
    switchOrganization: vi.fn(async ({ organizationId }) => {
      for (const purge of [...purgeHandlers]) purge();
      if (options.rejectSwitch) {
        throw new ApiClientError(
          'Não foi possível trocar de organização. Sua sessão atual foi mantida.',
          409,
          undefined,
          CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE,
        );
      }
      const selected = organizations.find((organization) => organization.id === organizationId);
      if (!selected) throw new Error('organização desconhecida');
      return browserSession(selected);
    }),
    request,
    login: vi.fn(), selectOrganization: vi.fn(), logout: vi.fn(),
    registerTenantPurge: vi.fn((handler: () => void) => {
      purgeHandlers.add(handler);
      return () => purgeHandlers.delete(handler);
    }),
    subscribeToSessionExpiration: vi.fn(() => () => undefined),
  } as unknown as ApiClient;
}

const first = {
  id: INSTANCE, organizationId: ORG, providerAccountId: ACCOUNT,
  name: 'Atendimento', provider: 'BAILEYS', status: 'CONNECTED', createdAt: now, updatedAt: now,
};

describe('ConnectionsPage', () => {
  it('filters loaded connections by name and status without claiming a global search', async () => {
    const request = vi.fn(async () => ({ data: [first, { ...first, id: INSTANCE_B, name: 'Comercial', status: 'DISCONNECTED' }], pageInfo: { hasNextPage: true, nextCursor: 'next' } })) as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes']} />);
    await screen.findByRole('link', { name: /Atendimento/ });
    fireEvent.change(screen.getByLabelText('Buscar conexão'), { target: { value: 'Comercial' } });
    expect(screen.queryByRole('link', { name: /Atendimento/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Comercial/ })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Filtrar por status'), { target: { value: 'CONNECTED' } });
    expect(screen.getByText('Nenhuma conexão corresponde aos filtros.')).toBeVisible();
    expect(screen.getByText(/Filtros aplicados às conexões carregadas/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Carregar mais' })).toBeVisible();
  });
  it('mostra loading, vazio e não inventa total global', async () => {
    let resolveList: ((value: unknown) => void) | undefined;
    const request = vi.fn((path: string) => {
      if (path.startsWith('/v1/instances?')) return new Promise((resolve) => { resolveList = resolve; });
      throw new Error(`unexpected ${path}`);
    }) as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes']} />);
    expect(await screen.findByText('Carregando conexões…')).toBeVisible();
    await waitFor(() => expect(request).toHaveBeenCalledWith('/v1/instances?limit=20'));
    expect(resolveList).toBeTypeOf('function');
    resolveList!({ data: [], pageInfo: { hasNextPage: false, nextCursor: null } });
    expect(await screen.findByText('Nenhuma conexão criada')).toBeVisible();
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument();
  });

  it('lista, pagina sem duplicar e mantém o cursor opaco', async () => {
    const request = vi.fn(async (path: string) => path.includes('cursor=opaque')
      ? { data: [{ ...first, name: 'Comercial', id: '9b3bb2cd-2b53-48cb-a758-bf72a85eb257' }], pageInfo: { hasNextPage: false, nextCursor: null } }
      : { data: [first], pageInfo: { hasNextPage: true, nextCursor: 'opaque' } }) as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes']} />);
    expect(await screen.findByRole('link', { name: /Atendimento/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByRole('link', { name: /Comercial/ })).toBeVisible();
    expect(request).toHaveBeenCalledWith('/v1/instances?limit=20&cursor=opaque');
  });

  it('mostra erro normalizado e request ID para suporte', async () => {
    const request = vi.fn(async () => {
      throw new ApiClientError('Serviço temporariamente indisponível. Tente novamente.', 502, '85a17103-9f0d-4d86-b55d-4184597e17a8');
    }) as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes']} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Serviço temporariamente indisponível');
    expect(screen.getByRole('alert')).toHaveTextContent('85a17103-9f0d-4d86-b55d-4184597e17a8');
  });

  it('mostra o estado proibido recebido do servidor', async () => {
    const request = vi.fn(async () => {
      throw new ApiClientError('Você não tem permissão para realizar esta ação.', 403);
    }) as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes']} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Você não tem permissão');
  });

  it('remove mutações para VIEWER', async () => {
    const request = vi.fn(async () => ({ data: [], pageInfo: { hasNextPage: false, nextCursor: null } })) as ApiClient['request'];
    render(<App client={appClient(request, 'VIEWER')} initialEntries={['/conexoes']} />);
    await screen.findByText('Nenhuma conexão criada');
    expect(screen.queryByRole('link', { name: 'Nova conexão' })).not.toBeInTheDocument();
    expect(screen.getByText('Seu acesso é somente leitura.')).toBeVisible();
  });

  it('limpa a lista anterior e recarrega conexões ao trocar de tenant', async () => {
    let lists = 0;
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith('/v1/instances?')) throw new Error(`unexpected ${path}`);
      lists += 1;
      return {
        data: [lists === 1
          ? first
          : { ...first, id: INSTANCE_B, organizationId: ORG_B, providerAccountId: ACCOUNT_B, name: 'Conexão filial' }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }) as ApiClient['request'];
    render(<App client={switchingAppClient(request)} initialEntries={['/conexoes']} />);
    expect(await screen.findByRole('link', { name: /Atendimento/ })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Organização ativa'), { target: { value: ORG_B } });

    expect(await screen.findByRole('link', { name: /Conexão filial/ })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Atendimento/ })).not.toBeInTheDocument();
    expect(lists).toBe(2);
  });

  it('recarrega o tenant de origem quando a troca é rejeitada após o purge', async () => {
    let lists = 0;
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith('/v1/instances?')) throw new Error(`unexpected ${path}`);
      lists += 1;
      return { data: [first], pageInfo: { hasNextPage: false, nextCursor: null } };
    }) as ApiClient['request'];
    render(<App client={switchingAppClient(request, { rejectSwitch: true })} initialEntries={['/conexoes']} />);
    expect(await screen.findByRole('link', { name: /Atendimento/ })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Organização ativa'), { target: { value: ORG_B } });

    expect(await screen.findByRole('alert')).toHaveTextContent('sessão atual foi mantida');
    await waitFor(() => expect(lists).toBe(2));
    expect(screen.getByRole('link', { name: /Atendimento/ })).toBeVisible();
    expect(screen.queryByText('Carregando conexões…')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Organização ativa')).toHaveValue(ORG);
  });
});

describe('NewConnectionPage', () => {
  it('descobre conta Baileys, cria com intenção em memória e abre o detalhe', async () => {
    const requestMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/v1/provider-accounts?')) return {
        data: [{ id: ACCOUNT, name: 'JRC QR Code principal', provider: 'BAILEYS', createdAt: now }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
      if (path === '/v1/instances' && init?.method === 'POST') return {
        instance: { ...first, status: 'CREATED' }, operationId: null,
        replayed: false, pending: false, reconciliationRequired: false,
      };
      if (path === `/v1/instances/${INSTANCE}`) return { ...first, status: 'CREATED' };
      throw new Error(`unexpected ${path}`);
    });
    const request = requestMock as unknown as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes/nova']} />);
    expect(await screen.findByText('JRC QR Code principal')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Nome da conexão'), { target: { value: 'Atendimento' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar conexão' }));
    expect(await screen.findByRole('heading', { name: 'Atendimento' })).toBeVisible();
    const createCall = requestMock.mock.calls.find(([path]) => path === '/v1/instances');
    expect(createCall?.[1]?.headers).toMatchObject({ 'Idempotency-Key': expect.any(String) });
    expect(JSON.stringify(createCall)).not.toContain(ORG);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('bloqueia criação sem provider account', async () => {
    const request = vi.fn(async () => ({ data: [], pageInfo: { hasNextPage: false, nextCursor: null } })) as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes/nova']} />);
    expect(await screen.findByText('Nenhuma conta JRC disponível')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Criar conexão' })).toBeDisabled();
  });

  it('limpa o formulário e recarrega provider accounts ao trocar de tenant', async () => {
    let accountLists = 0;
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith('/v1/provider-accounts?')) throw new Error(`unexpected ${path}`);
      accountLists += 1;
      return {
        data: [{
          id: accountLists === 1 ? ACCOUNT : ACCOUNT_B,
          name: accountLists === 1 ? 'JRC QR Code matriz' : 'JRC QR Code filial',
          provider: 'BAILEYS',
          createdAt: now,
        }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }) as ApiClient['request'];
    render(<App client={switchingAppClient(request)} initialEntries={['/conexoes/nova']} />);
    expect(await screen.findByText('JRC QR Code matriz')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Nome da conexão'), { target: { value: 'Não pode vazar' } });

    fireEvent.change(screen.getByLabelText('Organização ativa'), { target: { value: ORG_B } });

    expect(await screen.findByText('JRC QR Code filial')).toBeVisible();
    expect(screen.queryByText('JRC QR Code matriz')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Nome da conexão')).toHaveValue('');
    expect(screen.getByLabelText('Conta JRC')).toHaveValue(ACCOUNT_B);
    expect(accountLists).toBe(2);
  });

  it('recarrega as contas do tenant de origem quando a troca é rejeitada', async () => {
    let accountLists = 0;
    const request = vi.fn(async (path: string) => {
      if (!path.startsWith('/v1/provider-accounts?')) throw new Error(`unexpected ${path}`);
      accountLists += 1;
      return {
        data: [{ id: ACCOUNT, name: 'JRC QR Code matriz', provider: 'BAILEYS', createdAt: now }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
    }) as ApiClient['request'];
    render(<App client={switchingAppClient(request, { rejectSwitch: true })} initialEntries={['/conexoes/nova']} />);
    expect(await screen.findByText('JRC QR Code matriz')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Nome da conexão'), { target: { value: 'Não pode vazar' } });

    fireEvent.change(screen.getByLabelText('Organização ativa'), { target: { value: ORG_B } });

    expect(await screen.findByRole('alert')).toHaveTextContent('sessão atual foi mantida');
    await waitFor(() => expect(accountLists).toBe(2));
    expect(screen.getByText('JRC QR Code matriz')).toBeVisible();
    expect(screen.getByLabelText('Nome da conexão')).toHaveValue('');
    expect(screen.getByLabelText('Conta JRC')).toHaveValue(ACCOUNT);
    expect(screen.queryByText('Carregando contas JRC…')).not.toBeInTheDocument();
  });

  it('mostra indisponibilidade de rede ao descobrir provider accounts', async () => {
    const request = vi.fn(async () => {
      throw new ApiClientError('Não foi possível acessar o serviço. Tente novamente.', 0);
    }) as ApiClient['request'];
    render(<App client={appClient(request)} initialEntries={['/conexoes/nova']} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível acessar o serviço');
  });

  it('reutiliza a chave em resposta incerta e gera outra após mudar a intenção', async () => {
    let createAttempts = 0;
    const requestMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/v1/provider-accounts?')) return {
        data: [{ id: ACCOUNT, name: 'JRC QR Code principal', provider: 'BAILEYS', createdAt: now }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      };
      if (path === '/v1/instances' && init?.method === 'POST') {
        createAttempts += 1;
        if (createAttempts < 3) throw new ApiClientError('Não foi possível acessar o serviço. Tente novamente.', 0);
        return {
          instance: { ...first, status: 'CREATED' }, operationId: null,
          replayed: false, pending: false, reconciliationRequired: false,
        };
      }
      if (path === `/v1/instances/${INSTANCE}`) return { ...first, status: 'CREATED' };
      throw new Error(`unexpected ${path}`);
    });
    render(<App client={appClient(requestMock as unknown as ApiClient['request'])} initialEntries={['/conexoes/nova']} />);
    await screen.findByText('JRC QR Code principal');
    fireEvent.change(screen.getByLabelText('Nome da conexão'), { target: { value: 'Atendimento' } });

    fireEvent.click(screen.getByRole('button', { name: 'Criar conexão' }));
    await screen.findByRole('button', { name: 'Tentar criação novamente' });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar criação novamente' }));
    await screen.findByRole('button', { name: 'Tentar criação novamente' });
    fireEvent.change(screen.getByLabelText('Nome da conexão'), { target: { value: 'Atendimento novo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar conexão' }));
    await screen.findByRole('heading', { name: 'Atendimento' });

    const keys = requestMock.mock.calls
      .filter(([path]) => path === '/v1/instances')
      .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });
});
