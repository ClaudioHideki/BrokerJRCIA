// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE } from '@jrc/contracts';

import type { ApiClient } from '../api/client.js';
import { ApiClientError } from '../api/client.js';
import { App } from '../app/App.js';

const ORG = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const ORG_B = '11111111-2222-4333-8444-555555555555';
const ACCOUNT = '6fd7933a-80b7-4491-b081-a0fa8c2414d2';
const INSTANCE = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const OPERATION = '9271726c-8869-49ad-b0e0-57a4e0939ef7';
const now = '2030-01-01T12:00:00.000Z';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3aQAAAAASUVORK5CYII=';

function session(role: 'OWNER' | 'VIEWER' = 'OWNER') {
  const activeOrganization = { id: ORG, name: 'JRC Matriz', slug: 'jrc-matriz', role };
  return {
    accessToken: 'memory-only-canary', tokenType: 'Bearer' as const, expiresIn: 600,
    user: { id: '8e757fb4-18ff-4c20-841b-19f282ece546', email: 'owner@example.test' },
    activeOrganization, organizations: [activeOrganization],
  };
}

function client(request: ApiClient['request'], role: 'OWNER' | 'VIEWER' = 'OWNER'): ApiClient {
  return {
    restore: vi.fn(async () => session(role)),
    request: ((path, init) => path === '/v1/flows/status' ? Promise.resolve({ enabled: false }) : request(path, init)) as ApiClient['request'],
    login: vi.fn(), selectOrganization: vi.fn(), switchOrganization: vi.fn(), logout: vi.fn(),
    registerTenantPurge: vi.fn(() => () => undefined),
    subscribeToSessionExpiration: vi.fn(() => () => undefined),
  } as unknown as ApiClient;
}

function switchingClient(
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

function instance(status: string) {
  return {
    id: INSTANCE, organizationId: ORG, providerAccountId: ACCOUNT, name: 'Atendimento',
    provider: 'BAILEYS', status, createdAt: now, updatedAt: now,
  };
}

describe('ConnectionDetailPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('permite recuperar um novo QR quando o motor permanece conectando após recarregar', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/connect') && init?.method === 'POST') return {
        instance: instance('AWAITING_ACTION'), operationId: OPERATION,
        replayed: false, pending: true, reconciliationRequired: false,
        action: { type: 'QR_CODE', encoding: 'BASE64', value: PNG, expiresAt: '2099-01-01T00:00:00.000Z' },
      };
      return instance('CONNECTING');
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar conexão novamente' }));
    expect(await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' })).toBeVisible();
  });

  it('explica a falha de provisionamento sem oferecer pareamento indisponível', async () => {
    const request = vi.fn(async () => instance('PROVISIONING_FAILED')) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('O QR Code ainda não pode ser gerado');
    expect(screen.queryByRole('button', { name: /^Conectar$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Voltar à lista de conexões' })).toHaveAttribute('href', '/conexoes');
  });

  it('exige número no modo código e limpa o número ao voltar para QR', async () => {
    const bodies: unknown[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/connect')) {
        bodies.push(JSON.parse(String(init?.body)));
        return {
          instance: instance('AWAITING_ACTION'), operationId: OPERATION,
          replayed: false, pending: true, reconciliationRequired: false,
          action: { type: 'PAIRING_CODE', code: 'TEST1234', expiresAt: '2099-01-01T00:00:00.000Z' },
        };
      }
      return instance('CREATED');
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Código de pareamento' }));
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/número.*código do país/i);
    expect(bodies).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Número do WhatsApp'), { target: { value: '+1 (202) 555-0123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByText('TEST1234')).toBeVisible();
    expect(bodies).toEqual([{ pairingHint: '12025550123' }]);
    fireEvent.click(screen.getByRole('radio', { name: 'QR Code' }));
    expect(screen.queryByText('TEST1234')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Conectar|Gerar novo desafio/ }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({});
  });

  it('consulta manualmente o provider mesmo quando o estado local é terminal', async () => {
    const request = vi.fn(async (path: string) => instance(path.endsWith('/status') ? 'DISCONNECTED' : 'CONNECTED')) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    expect(await screen.findByText('Conectada')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar status' }));
    expect(await screen.findByText('Desconectada')).toBeVisible();
  });

  it.each([
    ['AWAITING_ACTION', 'CONNECTED', 'Conectada'],
    ['PROVISIONING', 'CREATED', 'Criada'],
    ['CONNECTING', 'CONNECTED', 'Conectada'],
  ])('após reload acompanha %s até o estado terminal %s', async (initial, terminal, label) => {
    const request = vi.fn(async (path: string) => path.endsWith('/status')
      ? instance(terminal)
      : instance(initial)) as ApiClient['request'];

    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);

    expect(await screen.findByText(label)).toBeVisible();
    expect(request).toHaveBeenCalledWith(`/v1/instances/${INSTANCE}/status`, expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('remove o erro transitório quando um polling posterior se recupera', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let statusReads = 0;
      const request = vi.fn(async (path: string) => {
        if (!path.endsWith('/status')) return instance('CONNECTING');
        statusReads += 1;
        if (statusReads === 1) {
          throw new ApiClientError('Serviço temporariamente indisponível. Tente novamente.', 502);
        }
        return instance('CONNECTED');
      }) as ApiClient['request'];
      render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);

      expect(await screen.findByRole('alert')).toHaveTextContent('temporariamente indisponível');
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(await screen.findByText('Conectada')).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mostra QR PNG validado sem persistir o desafio', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/connect') && init?.method === 'POST') return {
        instance: instance('AWAITING_ACTION'), operationId: OPERATION,
        replayed: false, pending: true, reconciliationRequired: false,
        action: { type: 'QR_CODE', encoding: 'BASE64', value: PNG, expiresAt: '2099-01-01T00:00:00.000Z' },
      };
      return instance('CREATED');
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    const image = await screen.findByRole('img', { name: 'QR Code para conectar o WhatsApp' });
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`);
    expect(document.body.textContent).not.toContain(PNG);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('renderiza pairing code somente como texto e limpa em nova intenção', async () => {
    let call = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/connect')) {
        call += 1;
        return {
          instance: instance('AWAITING_ACTION'), operationId: OPERATION,
          replayed: false, pending: true, reconciliationRequired: false,
          action: call === 1
            ? { type: 'PAIRING_CODE', code: '<b>123-456</b>', expiresAt: '2099-01-01T00:00:00.000Z' }
            : { type: 'NONE', reason: 'CONNECTION_PENDING' },
        };
      }
      return instance('AWAITING_ACTION');
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar novo desafio' }));
    expect(await screen.findByText('<b>123-456</b>')).toBeVisible();
    expect(document.querySelector('b')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar novo desafio' }));
    await waitFor(() => expect(screen.queryByText('<b>123-456</b>')).not.toBeInTheDocument());
    expect(screen.getByText(/operação de conexão está em andamento/i)).toBeVisible();
  });

  it('não transforma REDIRECT/EMBEDDED_SIGNUP em navegação', async () => {
    const request = vi.fn(async (path: string) => path.endsWith('/connect')
      ? {
          instance: instance('AWAITING_ACTION'), operationId: OPERATION,
          replayed: false, pending: true, reconciliationRequired: false,
          action: { type: 'REDIRECT', url: 'https://attacker.example/', expiresAt: '2099-01-01T00:00:00.000Z' },
        }
      : instance('CREATED')) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    expect(await screen.findByText('Este fluxo ainda não está disponível neste incremento.')).toBeVisible();
    expect(screen.queryByRole('link', { name: /attacker/i })).not.toBeInTheDocument();
    expect(window.location.href).not.toContain('attacker');
  });

  it('explica desafio perdido após reload e mantém VIEWER somente leitura', async () => {
    const request = vi.fn(async () => instance('AWAITING_ACTION')) as ApiClient['request'];
    render(<App client={client(request, 'VIEWER')} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    expect(await screen.findByText(/desafio anterior não fica armazenado/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Gerar novo desafio' })).not.toBeInTheDocument();
    expect(screen.getByText('Seu acesso é somente leitura.')).toBeVisible();
  });

  it('trata ausência 404 sem revelar detalhes internos', async () => {
    const requestId = '85a17103-9f0d-4d86-b55d-4184597e17a8';
    const request = vi.fn(async () => {
      throw new ApiClientError('O recurso solicitado não foi encontrado.', 404, requestId);
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    expect(await screen.findByRole('heading', { name: 'Conexão indisponível' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('não foi encontrado');
    expect(screen.getByRole('alert')).toHaveTextContent(requestId);
  });

  it('confirma desconexão e apresenta o novo estado', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const request = vi.fn(async (path: string) => path.endsWith('/disconnect')
      ? { instance: instance('DISCONNECTED'), operationId: OPERATION, replayed: false, pending: false, reconciliationRequired: false }
      : instance('CONNECTED')) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }));
    expect(await screen.findByText('Desconectada')).toBeVisible();
    expect(window.confirm).toHaveBeenCalled();
  });

  it('remove desafio e pairing, e recarrega o detalhe ao trocar de tenant', async () => {
    let detailReads = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/connect')) return {
        instance: instance('AWAITING_ACTION'), operationId: OPERATION,
        replayed: false, pending: true, reconciliationRequired: false,
        action: { type: 'PAIRING_CODE', code: '123-456', expiresAt: '2099-01-01T00:00:00.000Z' },
      };
      if (path.endsWith('/status')) return instance('AWAITING_ACTION');
      if (path.endsWith('/workspace')) return {};
      detailReads += 1;
      return detailReads === 1
        ? instance('CREATED')
        : { ...instance('CREATED'), organizationId: ORG_B, name: 'Atendimento filial' };
    }) as ApiClient['request'];
    render(<App client={switchingClient(request)} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Código de pareamento' }));
    fireEvent.change(screen.getByLabelText('Número do WhatsApp'), {
      target: { value: '5511999999999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByText('123-456')).toBeVisible();

    fireEvent.change(screen.getByLabelText('Organização ativa'), { target: { value: ORG_B } });

    expect(await screen.findByRole('heading', { name: 'Atendimento filial' })).toBeVisible();
    expect(screen.queryByText('123-456')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Número do WhatsApp')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'QR Code' })).toBeChecked();
    expect(detailReads).toBe(2);
  });

  it('recarrega o detalhe do tenant de origem quando a troca é rejeitada', async () => {
    let detailReads = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/status')) return instance('CREATED');
      if (path.endsWith('/workspace')) return {};
      detailReads += 1;
      return instance('CREATED');
    }) as ApiClient['request'];
    render(<App client={switchingClient(request, { rejectSwitch: true })} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);
    expect(await screen.findByRole('heading', { name: 'Atendimento' })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Organização ativa'), { target: { value: ORG_B } });

    expect(await screen.findByRole('alert')).toHaveTextContent('sessão atual foi mantida');
    await waitFor(() => expect(detailReads).toBe(2));
    expect(screen.getByRole('heading', { name: 'Atendimento' })).toBeVisible();
    expect(screen.queryByText('Carregando conexão…')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Organização ativa')).toHaveValue(ORG);
  });

  it('reutiliza a chave de connect incerto e gera outra após editar o pareamento', async () => {
    let connectAttempts = 0;
    const requestMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/connect')) {
        connectAttempts += 1;
        if (connectAttempts < 3) throw new ApiClientError('Não foi possível acessar o serviço. Tente novamente.', 0);
        return {
          instance: instance('CONNECTED'), operationId: OPERATION,
          replayed: false, pending: false, reconciliationRequired: false,
          action: { type: 'NONE', reason: 'ALREADY_CONNECTED' },
        };
      }
      return instance('CREATED');
    });
    render(<App client={client(requestMock as unknown as ApiClient['request'])} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    await screen.findByRole('button', { name: 'Tentar conexão novamente' });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar conexão novamente' }));
    await screen.findByRole('button', { name: 'Tentar conexão novamente' });
    fireEvent.click(screen.getByRole('radio', { name: 'Código de pareamento' }));
    fireEvent.change(screen.getByLabelText('Número do WhatsApp'), { target: { value: '5511999999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByText('Conectada')).toBeVisible();

    const keys = requestMock.mock.calls
      .filter(([path]) => path.endsWith('/connect'))
      .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('gera nova intenção após status manual comprovar encerramento da tentativa incerta', async () => {
    let connectAttempts = 0;
    const requestMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/connect')) {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          throw new ApiClientError('Não foi possível acessar o serviço. Tente novamente.', 0);
        }
        return {
          instance: instance('AWAITING_ACTION'), operationId: OPERATION,
          replayed: false, pending: true, reconciliationRequired: false,
          action: { type: 'NONE', reason: 'CONNECTION_PENDING' },
        };
      }
      if (path.endsWith('/status')) return instance('DISCONNECTED');
      return instance('CREATED');
    });
    render(<App client={client(requestMock as unknown as ApiClient['request'])} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Conectar' }));
    await screen.findByRole('button', { name: 'Tentar conexão novamente' });
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar status' }));
    expect(await screen.findByText('Desconectada')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    await waitFor(() => expect(connectAttempts).toBe(2));

    const keys = requestMock.mock.calls
      .filter(([path]) => path.endsWith('/connect'))
      .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('reutiliza a chave de disconnect após falha de rede incerta', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let disconnectAttempts = 0;
    const requestMock = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path.endsWith('/disconnect')) {
        disconnectAttempts += 1;
        if (disconnectAttempts === 1) throw new ApiClientError('Não foi possível acessar o serviço. Tente novamente.', 0);
        return {
          instance: instance('DISCONNECTED'), operationId: OPERATION,
          replayed: true, pending: false, reconciliationRequired: false,
        };
      }
      return instance('CONNECTED');
    });
    render(<App client={client(requestMock as unknown as ApiClient['request'])} initialEntries={[`/legacy/conexoes/${INSTANCE}`]} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    expect(await screen.findByText('Desconectada')).toBeVisible();

    const keys = requestMock.mock.calls
      .filter(([path]) => path.endsWith('/disconnect'))
      .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
  });
});
