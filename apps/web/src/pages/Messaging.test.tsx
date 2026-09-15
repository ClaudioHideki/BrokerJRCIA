// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../api/client.js';
import { SessionProvider } from '../auth/SessionProvider.js';
import { MessagingPage } from './Messaging.js';

const ORGANIZATION_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const CHANNEL_ID = '11111111-2222-4333-8444-555555555555';
const CONVERSATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONTACT_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const MESSAGE_ID = 'cccccccc-dddd-4eee-8fff-000000000000';

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

function session(role: Role) {
  const activeOrganization = {
    id: ORGANIZATION_ID,
    name: 'JRC Matriz',
    slug: 'jrc-matriz',
    role,
  };
  return {
    user: { id: '8e757fb4-18ff-4c20-841b-19f282ece546', email: 'owner@example.test' },
    activeOrganization,
    organizations: [activeOrganization],
  };
}

function clientFor(
  request: ApiClient['request'],
  role: Role = 'OWNER',
  registerTenantPurge: ApiClient['registerTenantPurge'] = vi.fn(() => () => undefined),
): ApiClient {
  return {
    restore: vi.fn(async () => session(role)),
    request,
    registerTenantPurge,
    subscribeToSessionExpiration: vi.fn(() => () => undefined),
    login: vi.fn(),
    selectOrganization: vi.fn(),
    switchOrganization: vi.fn(),
    logout: vi.fn(),
  } as unknown as ApiClient;
}

function renderPage(client: ApiClient) {
  return render(
    <SessionProvider client={client}>
      <MessagingPage />
    </SessionProvider>,
  );
}

function loadedRequest(overrides: {
  mode?: 'BOT' | 'HUMAN';
  templateBodyVariableCount?: number;
  templateStatus?: string;
  onMutation?: (path: string, init?: RequestInit) => unknown;
} = {}): ApiClient['request'] {
  return vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return overrides.onMutation?.(path, init);
    if (path === '/v1/messaging/channels') {
      return { data: [{ id: CHANNEL_ID, provider: 'META', botPublicId: 'jrc-welcome' }] };
    }
    if (path === `/v1/messaging/channels/${CHANNEL_ID}/templates`) {
      return { data: [
        {
          id: 'template-approved',
          name: 'welcome_pt',
          language: 'pt_BR',
          status: overrides.templateStatus ?? 'APPROVED',
          category: 'UTILITY',
          bodyVariableCount: overrides.templateBodyVariableCount ?? 2,
        },
        {
          id: 'template-paused',
          name: 'promo_paused',
          language: 'pt_BR',
          status: 'PAUSED',
          category: 'MARKETING',
          bodyVariableCount: 0,
        },
        {
          id: 'template-unsupported',
          name: 'media_header',
          language: 'pt_BR',
          status: overrides.templateStatus === 'REJECTED' ? 'REJECTED' : 'APPROVED',
          category: 'UTILITY',
          bodyVariableCount: null,
        },
      ] };
    }
    if (path === `/v1/messaging/channels/${CHANNEL_ID}/conversations`) {
      return { data: [{
        id: CONVERSATION_ID,
        channelId: CHANNEL_ID,
        contactId: CONTACT_ID,
        mode: overrides.mode ?? 'BOT',
      }] };
    }
    if (path === `/v1/messaging/conversations/${CONVERSATION_ID}/messages`) {
      return { data: [{
        id: MESSAGE_ID,
        direction: 'INCOMING',
        state: 'DELIVERED',
        text: 'Olá, preciso de ajuda',
      }] };
    }
    throw new Error(`unexpected request ${path}`);
  }) as ApiClient['request'];
}

describe('MessagingPage', () => {
  it('shows the honest empty state when no Meta channel is configured', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/messaging/channels') return { data: [] };
      throw new Error(`unexpected request ${path}`);
    }) as ApiClient['request'];

    renderPage(clientFor(request));

    expect(await screen.findByText('Nenhum canal configurado')).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/demonstração/i)).not.toBeInTheDocument();
  });

  it('loads channels, templates, conversations, and ordered message history', async () => {
    renderPage(clientFor(loadedRequest()));

    expect(await screen.findByRole('heading', { name: 'Conversas' })).toBeVisible();
    expect(await screen.findByText('Olá, preciso de ajuda')).toBeVisible();
    expect(screen.getByLabelText('Canal WhatsApp')).toHaveValue(CHANNEL_ID);
    expect(screen.getByLabelText('Conversa')).toHaveValue(CONVERSATION_ID);
    expect(screen.getByText('welcome_pt')).toBeVisible();
    expect(screen.getAllByText('APPROVED')).toHaveLength(2);
    expect(screen.getByText('promo_paused')).toBeVisible();
    expect(screen.getByText('PAUSED')).toBeVisible();
    expect(screen.getByText('Entrada · DELIVERED')).toBeVisible();

    const modelSelect = screen.getByLabelText('Modelo aprovado');
    expect(within(modelSelect).getByRole('option', { name: 'welcome_pt · pt_BR' })).toBeVisible();
    expect(within(modelSelect).queryByRole('option', { name: /promo_paused/ })).not.toBeInTheDocument();
    expect(within(modelSelect).queryByRole('option', { name: /media_header/ })).not.toBeInTheDocument();
  });

  it('sends ordered BODY variables only for a supported approved template', async () => {
    const mutations: Array<{ path: string; init?: RequestInit }> = [];
    const request = loadedRequest({
      onMutation(path, init) {
        mutations.push({ path, ...(init === undefined ? {} : { init }) });
        return { accepted: true };
      },
    });
    renderPage(clientFor(request));
    await screen.findByText('Olá, preciso de ajuda');

    fireEvent.change(screen.getByLabelText('Modelo aprovado'), {
      target: { value: 'template-approved' },
    });
    fireEvent.change(screen.getByLabelText('Variável 1'), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText('Variável 2'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar template' }));

    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.path).toBe(`/v1/messaging/channels/${CHANNEL_ID}/messages`);
    expect(mutations[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(mutations[0]?.init?.body))).toEqual({
      conversationId: CONVERSATION_ID,
      name: 'welcome_pt',
      language: 'pt_BR',
      variables: ['Ana', '42'],
    });
    expect(new Headers(mutations[0]?.init?.headers).get('Idempotency-Key')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('sends an approved fixed BODY without variable inputs', async () => {
    const mutations: Array<{ path: string; init?: RequestInit }> = [];
    const request = loadedRequest({
      templateBodyVariableCount: 0,
      onMutation(path, init) {
        mutations.push({ path, ...(init === undefined ? {} : { init }) });
        return { accepted: true };
      },
    });
    renderPage(clientFor(request));
    await screen.findByText('Olá, preciso de ajuda');

    expect(screen.queryByLabelText('Variável 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar template' }));

    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(JSON.parse(String(mutations[0]?.init?.body)).variables).toEqual([]);
  });

  it('does not enable sending when no approved template exists', async () => {
    const request = loadedRequest({ templateStatus: 'REJECTED' });
    renderPage(clientFor(request));

    await screen.findByText('Olá, preciso de ajuda');

    expect(screen.getByText('Nenhum template aprovado compatível disponível.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enviar template' })).toBeDisabled();
  });

  it('lets an operator assume a bot conversation through the mode endpoint', async () => {
    const mutations: Array<{ path: string; init?: RequestInit }> = [];
    const request = loadedRequest({
      onMutation(path, init) {
        mutations.push({ path, ...(init === undefined ? {} : { init }) });
        return { updated: true };
      },
    });
    renderPage(clientFor(request, 'OPERATOR'));
    await screen.findByText('Olá, preciso de ajuda');

    fireEvent.click(screen.getByRole('button', { name: 'Assumir atendimento' }));

    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.path).toBe(
      `/v1/messaging/conversations/${CONVERSATION_ID}/mode`,
    );
    expect(mutations[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(mutations[0]?.init?.body))).toEqual({ mode: 'HUMAN' });
    expect(await screen.findByText('Modo: Atendimento humano')).toBeVisible();
  });

  it('lets an admin configure a server-owned Typebot origin reference', async () => {
    const mutations: Array<{ path: string; init?: RequestInit }> = [];
    const request = loadedRequest({
      onMutation(path, init) {
        mutations.push({ path, ...(init === undefined ? {} : { init }) });
        return { id: CHANNEL_ID, provider: 'META', botPublicId: 'support-v2' };
      },
    });
    renderPage(clientFor(request, 'ADMIN'));
    await screen.findByText('Olá, preciso de ajuda');

    expect(screen.getByText('Fluxo atual: jrc-welcome')).toBeVisible();
    fireEvent.change(screen.getByLabelText('ID público do fluxo'), {
      target: { value: 'support-v2' },
    });
    fireEvent.change(screen.getByLabelText('Referência de origem'), {
      target: { value: 'typebot-cloud' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar automação' }));

    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.path).toBe(`/v1/messaging/channels/${CHANNEL_ID}/automation`);
    expect(mutations[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(mutations[0]?.init?.body))).toEqual({
      publicId: 'support-v2',
      originReference: 'typebot-cloud',
    });
    expect(await screen.findByText('Fluxo atual: support-v2')).toBeVisible();
  });

  it.each(['OPERATOR', 'VIEWER'] as const)(
    'keeps Typebot configuration unavailable to %s',
    async (role) => {
      renderPage(clientFor(loadedRequest(), role));
      await screen.findByText('Olá, preciso de ajuda');

      expect(screen.getByText('Fluxo atual: jrc-welcome')).toBeVisible();
      expect(screen.queryByLabelText('ID público do fluxo')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Referência de origem')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Salvar automação' })).not.toBeInTheDocument();
    },
  );

  it('keeps viewer access read-only', async () => {
    const request = loadedRequest();
    renderPage(clientFor(request, 'VIEWER'));

    expect(await screen.findByText('Olá, preciso de ajuda')).toBeVisible();
    expect(screen.getByText('Seu acesso é somente leitura.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Assumir atendimento' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enviar template' })).not.toBeInTheDocument();
  });

  it('aborts pending work and clears conversation state on tenant purge', async () => {
    let purge: (() => void) | undefined;
    let pendingSignal: AbortSignal | undefined;
    const registerTenantPurge: ApiClient['registerTenantPurge'] = vi.fn((handler) => {
      purge = handler;
      return () => undefined;
    });
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/v1/messaging/channels') {
        pendingSignal = init?.signal ?? undefined;
        return new Promise(() => undefined);
      }
      throw new Error(`unexpected request ${path}`);
    }) as ApiClient['request'];
    renderPage(clientFor(request, 'OWNER', registerTenantPurge));
    await waitFor(() => expect(pendingSignal).toBeInstanceOf(AbortSignal));

    purge?.();

    expect(pendingSignal?.aborted).toBe(true);
    expect(screen.queryByLabelText('Canal Meta')).not.toBeInTheDocument();
    expect(screen.queryByText('Olá, preciso de ajuda')).not.toBeInTheDocument();
  });
});
