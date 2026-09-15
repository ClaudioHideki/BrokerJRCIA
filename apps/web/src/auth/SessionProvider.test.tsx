// @vitest-environment jsdom

import { StrictMode, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ConsoleSessionResponse } from '@jrc/contracts';

import { ApiClientError, type ApiClient } from '../api/client.js';
import { SessionProvider, useSession } from './SessionProvider.js';

const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const SOURCE_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const TARGET_ID = '2db58223-99c7-4f16-8b59-0fe73aa395a8';
const SELECTION_TOKEN = 'S'.repeat(43);
const organizations = [
  { id: SOURCE_ID, name: 'JRC Matriz', slug: 'jrc-matriz', role: 'OWNER' as const },
  { id: TARGET_ID, name: 'JRC Filial', slug: 'jrc-filial', role: 'VIEWER' as const },
];

function session(activeIndex = 0): ConsoleSessionResponse {
  return {
    accessToken: `access-${activeIndex}`,
    tokenType: 'Bearer',
    expiresIn: 600,
    user: { id: USER_ID, email: 'owner@example.test' },
    activeOrganization: organizations[activeIndex]!,
    organizations,
  };
}

function fakeClient(overrides: Partial<ApiClient> = {}) {
  let expirationListener: (() => void) | undefined;
  const client: ApiClient = {
    login: vi.fn(async () => ({
      organizations,
      selectionToken: SELECTION_TOKEN,
      expiresAt: '2030-01-01T12:05:00.000Z',
    })),
    selectOrganization: vi.fn(async () => session()),
    restore: vi.fn(async () => session()),
    switchOrganization: vi.fn(async () => session(1)),
    logout: vi.fn(async () => undefined),
    async request<T>() { return {} as T; },
    registerTenantPurge: vi.fn(() => () => undefined),
    subscribeToSessionExpiration: vi.fn((listener) => {
      expirationListener = listener;
      return () => { expirationListener = undefined; };
    }),
    ...overrides,
  };
  return {
    client,
    expire() { expirationListener?.(); },
  };
}

function Probe() {
  const auth = useSession();
  return (
    <div>
      <output aria-label="estado">{auth.status}</output>
      <output aria-label="sessão-publicada">{JSON.stringify(auth.session)}</output>
      {auth.session ? <span>{auth.session.activeOrganization.name}</span> : null}
      {auth.selectionOrganizations.map((organization) => (
        <span key={organization.id}>{organization.name}</span>
      ))}
      {auth.notice ? <p>{auth.notice.message}</p> : null}
      <button type="button" onClick={() => void auth.login({
        email: 'owner@example.test',
        password: 'correct horse',
      })}>Entrar</button>
      <button type="button" onClick={() => void auth.selectOrganization(SOURCE_ID)}>Selecionar</button>
      <button type="button" onClick={() => void auth.switchOrganization(TARGET_ID)}>Trocar</button>
      <button type="button" onClick={() => void auth.logout()}>Sair</button>
    </div>
  );
}

function renderProvider(client: ApiClient, children: ReactNode = <Probe />) {
  return render(<SessionProvider client={client}>{children}</SessionProvider>);
}

describe('SessionProvider', () => {
  it('executa um único restore sob StrictMode e publica a sessão restaurada', async () => {
    const harness = fakeClient();

    render(
      <StrictMode>
        <SessionProvider client={harness.client}><Probe /></SessionProvider>
      </StrictMode>,
    );

    await screen.findByText('JRC Matriz');
    expect(screen.getByLabelText('estado')).toHaveTextContent('authenticated');
    expect(harness.client.restore).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('sessão-publicada')).not.toHaveTextContent('access-0');
    expect(screen.getByLabelText('sessão-publicada')).not.toHaveTextContent('accessToken');
  });

  it('mantém selection token somente na memória privada e o consome ao selecionar', async () => {
    const harness = fakeClient({
      restore: vi.fn(async () => { throw new ApiClientError('Sessão ausente.', 401); }),
    });
    const storageSpies = [
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
    ];
    renderProvider(harness.client);
    await waitFor(() => expect(screen.getByLabelText('estado')).toHaveTextContent('anonymous'));

    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await screen.findByText('JRC Matriz');
    expect(screen.getByLabelText('estado')).toHaveTextContent('selecting');
    expect(document.body.textContent).not.toContain(SELECTION_TOKEN);
    expect(window.location.href).not.toContain(SELECTION_TOKEN);
    for (const spy of storageSpies) expect(spy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
    await waitFor(() => expect(screen.getByLabelText('estado')).toHaveTextContent('authenticated'));
    expect(harness.client.selectOrganization).toHaveBeenCalledWith({
      selectionToken: SELECTION_TOKEN,
      organizationId: SOURCE_ID,
    });
  });

  it('consome o selection token antes do I/O e ignora seleção concorrente', async () => {
    let finishSelection: ((value: ConsoleSessionResponse) => void) | undefined;
    const selectOrganization = vi.fn(() => new Promise<ConsoleSessionResponse>((resolve) => {
      finishSelection = resolve;
    }));
    const harness = fakeClient({
      restore: vi.fn(async () => { throw new ApiClientError('Sessão ausente.', 401); }),
      selectOrganization,
    });
    renderProvider(harness.client);
    await waitFor(() => expect(screen.getByLabelText('estado')).toHaveTextContent('anonymous'));
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(screen.getByLabelText('estado')).toHaveTextContent('selecting'));

    fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar' }));

    expect(selectOrganization).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('estado')).toHaveTextContent('selecting');
    await act(async () => { finishSelection?.(session()); });
    expect(screen.getByLabelText('estado')).toHaveTextContent('authenticated');
  });

  it('entra em expired quando o cliente sinaliza segundo 401', async () => {
    const harness = fakeClient();
    renderProvider(harness.client);
    await waitFor(() => expect(screen.getByLabelText('estado')).toHaveTextContent('authenticated'));

    act(() => harness.expire());

    expect(screen.getByLabelText('estado')).toHaveTextContent('expired');
    expect(screen.getByText('Sua sessão expirou. Entre novamente.')).toBeVisible();
  });

  it('descarta resultado obsoleto de switch e mantém a organização publicada', async () => {
    let resolveSwitch: ((value: ConsoleSessionResponse) => void) | undefined;
    const harness = fakeClient({
      switchOrganization: vi.fn(() => new Promise<ConsoleSessionResponse>((resolve) => {
        resolveSwitch = resolve;
      })),
    });
    renderProvider(harness.client);
    await screen.findByText('JRC Matriz');

    fireEvent.click(screen.getByRole('button', { name: 'Trocar' }));
    act(() => harness.expire());
    await act(async () => { resolveSwitch?.(session(1)); });

    expect(screen.getByLabelText('estado')).toHaveTextContent('expired');
    expect(screen.queryByText('JRC Filial')).not.toBeInTheDocument();
  });

  it('limpa a sessão local mesmo quando logout remoto já está inválido', async () => {
    const harness = fakeClient({
      logout: vi.fn(async () => { throw new ApiClientError('Sua sessão expirou.', 401); }),
    });
    renderProvider(harness.client);
    await screen.findByText('JRC Matriz');

    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));

    await waitFor(() => expect(screen.getByLabelText('estado')).toHaveTextContent('anonymous'));
    expect(screen.queryByText('JRC Matriz')).not.toBeInTheDocument();
  });

  it('remove a sessão da árvore React antes de o logout remoto terminar', async () => {
    let finishLogout: (() => void) | undefined;
    const harness = fakeClient({
      logout: vi.fn(() => new Promise<void>((resolve) => {
        finishLogout = resolve;
      })),
    });
    renderProvider(harness.client);
    await screen.findByText('JRC Matriz');

    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));

    expect(screen.getByLabelText('estado')).toHaveTextContent('anonymous');
    expect(screen.queryByText('JRC Matriz')).not.toBeInTheDocument();
    await act(async () => finishLogout?.());
  });
});
