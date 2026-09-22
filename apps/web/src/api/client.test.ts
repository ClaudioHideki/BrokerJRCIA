// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  ApiClientError,
  StaleTenantResponseError,
  createApiClient,
} from './client.js';

const REQUEST_ID = '0e213691-faec-4abe-a3b6-439a6bedc80d';
const USER_ID = '8e757fb4-18ff-4c20-841b-19f282ece546';
const SOURCE_ID = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const TARGET_ID = '2db58223-99c7-4f16-8b59-0fe73aa395a8';
const SELECTION_TOKEN = 'selection-token-canary-value-00000000000000';
const ACCESS_TOKEN = 'access-token-canary';
const RENEWED_ACCESS_TOKEN = 'renewed-access-token-canary';

const organizations = [
  { id: SOURCE_ID, name: 'JRC Matriz', slug: 'jrc-matriz', role: 'OWNER' as const },
  { id: TARGET_ID, name: 'JRC Filial', slug: 'jrc-filial', role: 'VIEWER' as const },
];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function session(accessToken = ACCESS_TOKEN, activeIndex = 0) {
  return {
    accessToken,
    tokenType: 'Bearer' as const,
    expiresIn: 600,
    user: { id: USER_ID, email: 'owner@example.test' },
    activeOrganization: organizations[activeIndex]!,
    organizations,
  };
}

describe('createApiClient', () => {
  it('adds signed CSRF cookie only to exact first-party embed decisions', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }));
    const client = createApiClient({ fetchImpl, cookieSource: () => 'jrc_csrf=synthetic-csrf' });
    for (const action of ['approve', 'deny', 'exchange']) {
      await client.request(`/v1/embed/authorizations/${REQUEST_ID}/${action}`, { method: 'POST', body: '{}' });
      const headers = new Headers(fetchImpl.mock.calls.at(-1)?.[1]?.headers);
      expect(headers.get('x-csrf-token')).toBe(action === 'exchange' ? null : 'synthetic-csrf');
    }
  });
  it('usa URL relativa, same-origin, bearer em closure e CSRF somente nas rotas cookie-auth', async () => {
    document.cookie = 'jrc_csrf=csrf-cookie-value; Path=/';
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === '/v1/auth/login') {
        return jsonResponse({
          organizations,
          selectionToken: SELECTION_TOKEN,
          expiresAt: '2030-01-01T12:05:00.000Z',
        });
      }
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') return jsonResponse(session(ACCESS_TOKEN, 1));
      if (input === '/v1/console/auth/restore') return jsonResponse(session(RENEWED_ACCESS_TOKEN));
      if (input === '/v1/console/auth/logout') return new Response(null, { status: 204 });
      return jsonResponse({ items: [] });
    });
    const client = createApiClient({ fetchImpl });

    await client.login({ email: 'owner@example.test', password: 'correct horse' });
    const selected = await client.selectOrganization({
      selectionToken: SELECTION_TOKEN,
      organizationId: SOURCE_ID,
    });
    await client.request('/v1/instances');
    const switched = await client.switchOrganization({ organizationId: TARGET_ID });
    const restored = await client.restore();
    await client.logout();

    for (const publicSession of [selected, switched, restored]) {
      expect(publicSession).not.toHaveProperty('accessToken');
      expect(publicSession).not.toHaveProperty('tokenType');
      expect(publicSession).not.toHaveProperty('expiresIn');
    }

    expect(calls.map(([url]) => url)).toEqual([
      '/v1/auth/login',
      '/v1/console/auth/select-organization',
      '/v1/instances',
      '/v1/console/auth/switch-organization',
      '/v1/console/auth/restore',
      '/v1/console/auth/logout',
    ]);
    for (const [url, init] of calls) {
      expect(String(url).startsWith('/v1/')).toBe(true);
      expect(init?.credentials).toBe('same-origin');
    }
    expect(new Headers(calls[1]![1]?.headers).has('x-csrf-token')).toBe(false);
    expect(new Headers(calls[2]![1]?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(new Headers(calls[3]![1]?.headers).get('x-csrf-token')).toBe('csrf-cookie-value');
    expect(new Headers(calls[4]![1]?.headers).get('authorization')).toBeNull();
    expect(new Headers(calls[4]![1]?.headers).get('x-csrf-token')).toBe('csrf-cookie-value');
    expect(new Headers(calls[5]![1]?.headers).get('x-csrf-token')).toBe('csrf-cookie-value');
  });

  it('recusa URL absoluta antes de chamar fetch', async () => {
    const fetchImpl = vi.fn();
    const client = createApiClient({ fetchImpl });

    await expect(client.request('https://attacker.invalid/v1/instances'))
      .rejects.toThrow('A API aceita somente caminhos relativos');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('compartilha um restore para 401 concorrentes e repete cada request uma única vez', async () => {
    let restoreCalls = 0;
    let instanceCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        await Promise.resolve();
        return jsonResponse(session(RENEWED_ACCESS_TOKEN));
      }
      if (input === '/v1/instances') {
        instanceCalls += 1;
        const bearer = new Headers(init?.headers).get('authorization');
        return bearer === `Bearer ${RENEWED_ACCESS_TOKEN}`
          ? jsonResponse({ ok: true })
          : jsonResponse({ status: 401, code: 'INVALID_SESSION', title: 'hidden' }, 401);
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(Promise.all([
      client.request('/v1/instances'),
      client.request('/v1/instances'),
    ])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(restoreCalls).toBe(1);
    expect(instanceCalls).toBe(4);
  });

  it('não rotaciona o refresh novamente quando um 401 do token anterior chega atrasado', async () => {
    let restoreCalls = 0;
    let releaseLateUnauthorized: (() => void) | undefined;
    const lateUnauthorized = new Promise<void>((resolve) => {
      releaseLateUnauthorized = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        return jsonResponse(session(RENEWED_ACCESS_TOKEN));
      }
      const bearer = new Headers(init?.headers).get('authorization');
      if (input === '/v1/instances/first') {
        return bearer === `Bearer ${RENEWED_ACCESS_TOKEN}`
          ? jsonResponse({ id: 'first' })
          : jsonResponse({ status: 401 }, 401);
      }
      if (input === '/v1/instances/late') {
        if (bearer === `Bearer ${RENEWED_ACCESS_TOKEN}`) return jsonResponse({ id: 'late' });
        await lateUnauthorized;
        return jsonResponse({ status: 401 }, 401);
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const lateRequest = client.request('/v1/instances/late');
    await expect(client.request('/v1/instances/first')).resolves.toEqual({ id: 'first' });
    releaseLateUnauthorized?.();

    await expect(lateRequest).resolves.toEqual({ id: 'late' });
    expect(restoreCalls).toBe(1);
  });

  it('não rotaciona o refresh novamente quando o 401 tardio pertence ao switch', async () => {
    let restoreCalls = 0;
    let releaseSwitch: (() => void) | undefined;
    let markSwitchStarted: (() => void) | undefined;
    const switchStarted = new Promise<void>((resolve) => {
      markSwitchStarted = resolve;
    });
    const switchBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        return jsonResponse(session(RENEWED_ACCESS_TOKEN));
      }
      if (input === '/v1/console/auth/switch-organization') {
        switchBearers.push(new Headers(init?.headers).get('authorization'));
        if (switchBearers.length === 1) {
          markSwitchStarted?.();
          await new Promise<void>((resolve) => {
            releaseSwitch = resolve;
          });
          return jsonResponse({ status: 401 }, 401);
        }
        return jsonResponse(session('target-access-token-canary', 1));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const switching = client.switchOrganization({ organizationId: TARGET_ID });
    await switchStarted;
    await client.restore();
    releaseSwitch?.();

    await expect(switching).resolves.toMatchObject({ activeOrganization: { id: TARGET_ID } });
    expect(restoreCalls).toBe(1);
    expect(switchBearers).toEqual([
      `Bearer ${ACCESS_TOKEN}`,
      `Bearer ${RENEWED_ACCESS_TOKEN}`,
    ]);
  });

  it('não expira um token mais novo quando o retry do switch recebe 401 atrasado', async () => {
    let restoreCalls = 0;
    let switchCalls = 0;
    let releaseRetry: (() => void) | undefined;
    let markRetryStarted: (() => void) | undefined;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const expired = vi.fn();
    const finalBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        const token = restoreCalls === 1
          ? RENEWED_ACCESS_TOKEN
          : 'newest-access-token-canary';
        return jsonResponse(session(token));
      }
      if (input === '/v1/console/auth/switch-organization') {
        switchCalls += 1;
        if (switchCalls === 1) return jsonResponse({ status: 401 }, 401);
        markRetryStarted?.();
        await new Promise<void>((resolve) => {
          releaseRetry = resolve;
        });
        return jsonResponse({ status: 401 }, 401);
      }
      if (input === '/v1/instances') {
        finalBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const switching = client.switchOrganization({ organizationId: TARGET_ID });
    await retryStarted;
    await client.restore();
    releaseRetry?.();

    await expect(switching).rejects.toMatchObject({ status: 401 });
    await client.request('/v1/instances');
    expect(expired).not.toHaveBeenCalled();
    expect(finalBearers).toEqual(['Bearer newest-access-token-canary']);
  });

  it('não restaura novamente após o segundo 401 e sinaliza sessão expirada', async () => {
    let restoreCalls = 0;
    const expired = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        return jsonResponse(session(RENEWED_ACCESS_TOKEN));
      }
      return jsonResponse({ status: 401, code: 'INVALID_SESSION', title: 'hidden' }, 401);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(client.request('/v1/instances')).rejects.toMatchObject({ status: 401 });
    expect(restoreCalls).toBe(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/v1/auth/login', 'login'],
    ['/v1/console/auth/restore', 'restore'],
    ['/v1/console/auth/logout', 'logout'],
  ])('não aplica retry automático a %s', async (url, method) => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => jsonResponse({
      status: 401,
      code: 'INVALID_SESSION',
      title: 'hidden',
    }, 401));
    const client = createApiClient({ fetchImpl });

    const operation = method === 'login'
      ? client.login({ email: 'owner@example.test', password: 'wrong' })
      : method === 'restore'
        ? client.restore()
        : client.logout();
    await expect(operation).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(url);
  });

  it('normaliza problem+json sem revelar detalhes e conserva apenas requestId UUID', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      type: 'about:blank',
      title: 'database password leaked',
      detail: 'stack and secret leaked',
      status: 503,
      code: 'INTERNAL_ERROR',
      requestId: REQUEST_ID,
      correlationId: REQUEST_ID,
    }), {
      status: 503,
      headers: { 'content-type': 'application/problem+json' },
    }));
    const client = createApiClient({ fetchImpl });

    const error = await client.login({ email: 'owner@example.test', password: 'wrong' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      message: 'Serviço temporariamente indisponível. Tente novamente.',
      requestId: REQUEST_ID,
      correlationId: REQUEST_ID,
      status: 503,
    });
    expect(String(error)).not.toContain('database password');
    expect(String(error)).not.toContain('stack and secret');
  });

  it('aborta e purga o tenant anterior antes do switch e descarta resposta obsoleta', async () => {
    const events: string[] = [];
    let resolveOld: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/instances') {
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      }
      if (input === '/v1/console/auth/switch-organization') {
        events.push('switch-request');
        return jsonResponse(session(RENEWED_ACCESS_TOKEN, 1));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });
    client.registerTenantPurge(() => { events.push('purge'); });
    const oldRequest = client.request('/v1/instances');

    const switched = await client.switchOrganization({ organizationId: TARGET_ID });
    resolveOld?.(jsonResponse({ items: [{ id: 'stale' }] }));

    expect(events).toEqual(['purge', 'switch-request']);
    expect(switched.activeOrganization.id).toBe(TARGET_ID);
    await expect(oldRequest).rejects.toBeInstanceOf(StaleTenantResponseError);
  });

  it('descarta resposta cujo body termina de ser lido depois da troca de tenant', async () => {
    let releaseBody: ((body: unknown) => void) | undefined;
    let bodyReadStarted: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyReadStarted = resolve;
    });
    const delayedBody = new Promise<unknown>((resolve) => {
      releaseBody = resolve;
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/instances') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => {
            bodyReadStarted?.();
            return delayedBody;
          },
        } as Response;
      }
      if (input === '/v1/console/auth/switch-organization') {
        return jsonResponse(session(RENEWED_ACCESS_TOKEN, 1));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const oldRequest = client.request('/v1/instances');
    await bodyStarted;
    await client.switchOrganization({ organizationId: TARGET_ID });
    releaseBody?.({ items: [{ id: 'stale' }] });

    await expect(oldRequest).rejects.toBeInstanceOf(StaleTenantResponseError);
  });

  it('não repete no novo tenant uma request que recebeu 401 no tenant anterior', async () => {
    let releaseRestore: ((response: Response) => void) | undefined;
    let restoreStarted: (() => void) | undefined;
    const restoreRequestStarted = new Promise<void>((resolve) => {
      restoreStarted = resolve;
    });
    let instanceCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/instances') {
        instanceCalls += 1;
        return jsonResponse({ status: 401 }, 401);
      }
      if (input === '/v1/console/auth/restore') {
        restoreStarted?.();
        return new Promise<Response>((resolve) => {
          releaseRestore = resolve;
        });
      }
      if (input === '/v1/console/auth/switch-organization') {
        return jsonResponse(session('target-access-token-canary', 1));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const oldRequest = client.request('/v1/instances');
    await restoreRequestStarted;
    const switched = client.switchOrganization({ organizationId: TARGET_ID });
    releaseRestore?.(jsonResponse(session(RENEWED_ACCESS_TOKEN)));

    await expect(oldRequest).rejects.toBeInstanceOf(StaleTenantResponseError);
    await expect(switched).resolves.toMatchObject({ activeOrganization: { id: TARGET_ID } });
    expect(instanceCalls).toBe(1);
  });

  it('expira e limpa o bearer quando o switch pode ter alterado o cookie mas retorna payload inválido', async () => {
    const expired = vi.fn();
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') return jsonResponse({ switched: true });
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(client.switchOrganization({ organizationId: TARGET_ID }))
      .rejects.toMatchObject({ status: 502 });
    await client.request('/v1/instances');

    expect(expired).toHaveBeenCalledTimes(1);
    expect(requestBearers).toEqual([null]);
  });

  it('expira e limpa o bearer quando o switch retorna erro 5xx potencialmente mutante', async () => {
    const expired = vi.fn();
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') {
        return jsonResponse({ status: 503 }, 503);
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(client.switchOrganization({ organizationId: TARGET_ID }))
      .rejects.toMatchObject({ status: 503 });
    await client.request('/v1/instances');

    expect(expired).toHaveBeenCalledTimes(1);
    expect(requestBearers).toEqual([null]);
  });

  it('preserva a sessão fonte quando somente o destino do switch é rejeitado', async () => {
    let restoreCalls = 0;
    const expired = vi.fn();
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') {
        return jsonResponse({
          type: 'about:blank',
          title: 'Organization switch failed',
          status: 409,
          code: 'ORGANIZATION_SWITCH_REJECTED',
          requestId: REQUEST_ID,
        }, 409, { 'content-type': 'application/problem+json' });
      }
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        return jsonResponse(session(RENEWED_ACCESS_TOKEN));
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(client.switchOrganization({ organizationId: TARGET_ID })).rejects.toMatchObject({
      status: 409,
      requestId: REQUEST_ID,
      message: 'Não foi possível trocar de organização. Sua sessão atual foi mantida.',
    });
    await expect(client.request('/v1/instances')).resolves.toEqual({ items: [] });

    expect(restoreCalls).toBe(0);
    expect(expired).not.toHaveBeenCalled();
    expect(requestBearers).toEqual([`Bearer ${ACCESS_TOKEN}`]);
  });

  it('não trata 409 desconhecido como garantia de sessão preservada', async () => {
    const expired = vi.fn();
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') {
        return jsonResponse({
          type: 'about:blank',
          title: 'Unknown conflict',
          status: 409,
          code: 'OTHER_CONFLICT',
        }, 409, { 'content-type': 'application/problem+json' });
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(client.switchOrganization({ organizationId: TARGET_ID })).rejects.toMatchObject({
      status: 409,
      message: 'Revise os dados informados e tente novamente.',
    });
    await client.request('/v1/instances');

    expect(expired).toHaveBeenCalledTimes(1);
    expect(requestBearers).toEqual([null]);
  });

  it('expira a sessão quando o refresh é realmente inválido durante o switch', async () => {
    let restoreCalls = 0;
    const expired = vi.fn();
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') {
        return jsonResponse({ status: 401, code: 'INVALID_SESSION' }, 401);
      }
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        return jsonResponse({ status: 401, code: 'INVALID_SESSION' }, 401);
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(client.switchOrganization({ organizationId: TARGET_ID }))
      .rejects.toMatchObject({ status: 401 });
    await client.request('/v1/instances');

    expect(restoreCalls).toBe(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(requestBearers).toEqual([null]);
  });

  it('não mantém bearer restaurado invisivelmente quando mismatch termina em destino rejeitado', async () => {
    let switchCalls = 0;
    const expired = vi.fn();
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') {
        switchCalls += 1;
        return switchCalls === 1
          ? jsonResponse({ status: 401, code: 'INVALID_SESSION' }, 401)
          : jsonResponse({
              type: 'about:blank',
              title: 'Organization switch failed',
              status: 409,
              code: 'ORGANIZATION_SWITCH_REJECTED',
            }, 409, { 'content-type': 'application/problem+json' });
      }
      if (input === '/v1/console/auth/restore') {
        return jsonResponse(session(RENEWED_ACCESS_TOKEN, 1));
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    await expect(client.switchOrganization({ organizationId: TARGET_ID }))
      .rejects.toMatchObject({ status: 409 });
    await client.request('/v1/instances');

    expect(switchCalls).toBe(2);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(requestBearers).toEqual([null]);
  });

  it('não deixa uma request da nova geração aderir ao restore da geração anterior', async () => {
    let releaseRestore: ((response: Response) => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    let markPurged: (() => void) | undefined;
    const tenantPurged = new Promise<void>((resolve) => {
      markPurged = resolve;
    });
    const expired = vi.fn();
    const finalBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/restore') {
        markRestoreStarted?.();
        return new Promise<Response>((resolve) => {
          releaseRestore = resolve;
        });
      }
      if (input === '/v1/instances/old' || input === '/v1/instances/during-switch') {
        return jsonResponse({ status: 401 }, 401);
      }
      if (input === '/v1/console/auth/switch-organization') {
        return jsonResponse(session('target-access-token-canary', 1));
      }
      if (input === '/v1/instances/final') {
        finalBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ id: 'final' });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    client.subscribeToSessionExpiration(expired);
    client.registerTenantPurge(() => markPurged?.());
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const oldRequest = client.request('/v1/instances/old');
    await restoreStarted;
    const switching = client.switchOrganization({ organizationId: TARGET_ID });
    await tenantPurged;
    const duringSwitch = client.request('/v1/instances/during-switch');
    releaseRestore?.(jsonResponse(session(RENEWED_ACCESS_TOKEN)));

    await expect(oldRequest).rejects.toBeInstanceOf(StaleTenantResponseError);
    await expect(duringSwitch).rejects.toBeInstanceOf(StaleTenantResponseError);
    await expect(switching).resolves.toMatchObject({ activeOrganization: { id: TARGET_ID } });
    await expect(client.request('/v1/instances/final')).resolves.toEqual({ id: 'final' });
    expect(expired).not.toHaveBeenCalled();
    expect(finalBearers).toEqual(['Bearer target-access-token-canary']);
  });

  it('serializa trocas de organização e usa a sessão publicada pela troca anterior', async () => {
    let releaseFirstSwitch: ((response: Response) => void) | undefined;
    const switchBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') {
        switchBearers.push(new Headers(init?.headers).get('authorization'));
        if (switchBearers.length === 1) {
          return new Promise<Response>((resolve) => {
            releaseFirstSwitch = resolve;
          });
        }
        return jsonResponse(session('second-switch-access-token-canary', 0));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const first = client.switchOrganization({ organizationId: TARGET_ID });
    const second = client.switchOrganization({ organizationId: SOURCE_ID });
    await Promise.resolve();
    expect(switchBearers).toEqual([`Bearer ${ACCESS_TOKEN}`]);

    releaseFirstSwitch?.(jsonResponse(session(RENEWED_ACCESS_TOKEN, 1)));
    await expect(first).resolves.toMatchObject({ activeOrganization: { id: TARGET_ID } });
    await expect(second).resolves.toMatchObject({ activeOrganization: { id: SOURCE_ID } });
    expect(switchBearers).toEqual([
      `Bearer ${ACCESS_TOKEN}`,
      `Bearer ${RENEWED_ACCESS_TOKEN}`,
    ]);
  });

  it('aguarda restore em voo antes do logout e nunca republica uma sessão zumbi', async () => {
    const events: string[] = [];
    let releaseRestore: ((response: Response) => void) | undefined;
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/restore') {
        events.push('restore');
        markRestoreStarted?.();
        return new Promise<Response>((resolve) => {
          releaseRestore = resolve;
        });
      }
      if (input === '/v1/console/auth/logout') {
        events.push('logout');
        return new Response(null, { status: 204 });
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const restoring = client.restore();
    await restoreStarted;
    const loggingOut = client.logout();
    await Promise.resolve();
    const eventsBeforeRestoreFinished = [...events];
    releaseRestore?.(jsonResponse(session(RENEWED_ACCESS_TOKEN)));

    await expect(restoring).rejects.toBeInstanceOf(StaleTenantResponseError);
    await expect(loggingOut).resolves.toBeUndefined();
    await client.request('/v1/instances');
    expect(eventsBeforeRestoreFinished).toEqual(['restore']);
    expect(events).toEqual(['restore', 'logout']);
    expect(requestBearers).toEqual([null]);
  });

  it('invalida o bearer imediatamente e conclui logout somente depois de um switch em voo', async () => {
    const events: string[] = [];
    let releaseSwitch: ((response: Response) => void) | undefined;
    let markSwitchStarted: (() => void) | undefined;
    const switchStarted = new Promise<void>((resolve) => {
      markSwitchStarted = resolve;
    });
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      if (input === '/v1/console/auth/switch-organization') {
        events.push('switch');
        markSwitchStarted?.();
        return new Promise<Response>((resolve) => {
          releaseSwitch = resolve;
        });
      }
      if (input === '/v1/console/auth/logout') {
        events.push('logout');
        return new Response(null, { status: 204 });
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });
    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });

    const switching = client.switchOrganization({ organizationId: TARGET_ID });
    await switchStarted;
    const loggingOut = client.logout();
    await client.request('/v1/instances');

    expect(events).toEqual(['switch']);
    expect(requestBearers).toEqual([null]);
    releaseSwitch?.(jsonResponse(session(RENEWED_ACCESS_TOKEN, 1)));

    await expect(switching).rejects.toBeInstanceOf(StaleTenantResponseError);
    await expect(loggingOut).resolves.toBeUndefined();
    expect(events).toEqual(['switch', 'logout']);
    await expect(client.switchOrganization({ organizationId: SOURCE_ID }))
      .rejects.toMatchObject({ status: 401 });
  });

  it('recusa restore iniciado durante logout mesmo quando ainda não havia bearer', async () => {
    let releaseLogout: (() => void) | undefined;
    let markLogoutStarted: (() => void) | undefined;
    const logoutStarted = new Promise<void>((resolve) => {
      markLogoutStarted = resolve;
    });
    let releaseRestore: ((response: Response) => void) | undefined;
    let restoreCalls = 0;
    const requestBearers: Array<string | null> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/logout') {
        markLogoutStarted?.();
        await new Promise<void>((resolve) => {
          releaseLogout = resolve;
        });
        return new Response(null, { status: 204 });
      }
      if (input === '/v1/console/auth/restore') {
        restoreCalls += 1;
        return new Promise<Response>((resolve) => {
          releaseRestore = resolve;
        });
      }
      if (input === '/v1/instances') {
        requestBearers.push(new Headers(init?.headers).get('authorization'));
        return jsonResponse({ items: [] });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const client = createApiClient({ fetchImpl });

    const loggingOut = client.logout();
    await logoutStarted;
    const restoring = client.restore();
    const restoreOutcome = expect(restoring).rejects.toBeInstanceOf(StaleTenantResponseError);
    releaseLogout?.();
    await loggingOut;
    releaseRestore?.(jsonResponse(session(RENEWED_ACCESS_TOKEN)));

    await restoreOutcome;
    await client.request('/v1/instances');
    expect(restoreCalls).toBe(0);
    expect(requestBearers).toEqual([null]);
  });

  it('remove os dois cookies CSRF quando o logout fica incerto e bloqueia restore após reload', async () => {
    const cookies = new Map([
      ['jrc_csrf', 'development-csrf-canary'],
      ['__Host-jrc_csrf', 'production-csrf-canary'],
    ]);
    const cookieWrites: string[] = [];
    const cookieSource = () => [...cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const cookieSink = (serialized: string) => {
      cookieWrites.push(serialized);
      const name = serialized.slice(0, serialized.indexOf('='));
      if (/Max-Age=0/i.test(serialized)) cookies.delete(name);
    };
    const restoreHeaders: Headers[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/v1/console/auth/logout') {
        throw new TypeError('network unavailable');
      }
      if (input === '/v1/console/auth/restore') {
        const headers = new Headers(init?.headers);
        restoreHeaders.push(headers);
        return headers.has('x-csrf-token')
          ? jsonResponse(session(RENEWED_ACCESS_TOKEN))
          : jsonResponse({ status: 403, code: 'INVALID_CSRF', title: 'hidden' }, 403, {
            'content-type': 'application/problem+json',
          });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    const firstClient = createApiClient({ fetchImpl, cookieSource, cookieSink });

    await expect(firstClient.logout()).rejects.toMatchObject({ status: 0 });
    expect(cookieSource()).toBe('');
    expect(cookieWrites).toEqual(expect.arrayContaining([
      expect.stringMatching(/^jrc_csrf=;.*Max-Age=0/i),
      expect.stringMatching(/^__Host-jrc_csrf=;.*Max-Age=0/i),
    ]));

    const clientAfterReload = createApiClient({ fetchImpl, cookieSource, cookieSink });
    await expect(clientAfterReload.restore()).rejects.toMatchObject({ status: 403 });
    expect(restoreHeaders).toHaveLength(1);
    expect(restoreHeaders[0]?.has('x-csrf-token')).toBe(false);
  });

  it('não persiste nem propaga access token para storage, URL, DOM, body ou IndexedDB', async () => {
    const storageSpies = [
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
    ];
    const indexedDbSpy = vi.fn(() => { throw new Error('IndexedDB must not be opened'); });
    vi.stubGlobal('indexedDB', { open: indexedDbSpy });
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      if (input === '/v1/console/auth/select-organization') return jsonResponse(session());
      return jsonResponse({ items: [] });
    });
    const client = createApiClient({ fetchImpl });

    await client.selectOrganization({ selectionToken: SELECTION_TOKEN, organizationId: SOURCE_ID });
    await client.request('/v1/instances', { method: 'POST', body: JSON.stringify({ name: 'safe' }) });

    for (const spy of storageSpies) expect(spy).not.toHaveBeenCalled();
    expect(indexedDbSpy).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(ACCESS_TOKEN);
    expect(document.body.textContent).not.toContain(ACCESS_TOKEN);
    for (const [url, init] of calls) {
      expect(String(url)).not.toContain(ACCESS_TOKEN);
      expect(String(init?.body ?? '')).not.toContain(ACCESS_TOKEN);
    }
  });
});
