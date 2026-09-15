import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import {
  EvolutionProviderAdapter,
  type EvolutionTimeouts,
  type ProviderContext,
} from '../src/index.js';
import { evolutionFixtures } from './fixtures/evolution-responses.js';

const platformSecret = 'platform-evolution-secret-canary';
const upstreamInstanceKey = 'jrc_018f17dd-c346-7fb0-9a3c-97f9cb3ba243';
const fixedNow = new Date('2029-01-01T00:00:00.000Z');
const fixedExpiry = '2029-01-01T00:01:00.000Z';

const timeouts: EvolutionTimeouts = {
  provisionInstance: 1_001,
  beginConnection: 1_002,
  getStatus: 1_003,
  disconnect: 1_004,
  lookupInstance: 1_005,
  reconcileProvisioning: 1_006,
  deprovisionInstance: 1_007,
};

const context: ProviderContext = {
  organizationId: 'ed3ca47c-4f7e-4ce4-a3c7-32b1e3bc446d',
  requestId: 'req-evolution-adapter',
  deadline: new Date('2030-01-01T00:00:00.000Z'),
  signal: new AbortController().signal,
};

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function listen(listener: RequestListener): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}/` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function createAdapter(
  responses: Array<Response | ((url: string, init: RequestInit) => Response | Promise<Response>)>,
) {
  const requests: RecordedRequest[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const normalizedInit = init ?? {};
    requests.push({ url, init: normalizedInit });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error('unexpected test request');
    }
    return typeof next === 'function' ? next(url, normalizedInit) : next;
  });

  return {
    adapter: new EvolutionProviderAdapter({
      baseUrl: 'http://evolution.internal:8080/',
      apiKey: platformSecret,
      fetch,
      now: () => fixedNow,
      challengeTtlMs: 60_000,
      deprovisionPollIntervalMs: 1,
      timeouts,
    }),
    fetch,
    requests,
  };
}

describe('EvolutionProviderAdapter', () => {
  it('provisiona uma instância Baileys com a chave determinística e descarta campos desconhecidos', async () => {
    const { adapter, requests } = createAdapter([jsonResponse(evolutionFixtures.created, 201)]);

    const result = await adapter.provisionInstance(context, {
      upstreamInstanceKey,
      providerAccountId: '7c0766da-2524-443a-a45b-ab3de2a49b1f',
    });

    expect(result).toEqual({ reference: { id: upstreamInstanceKey }, status: 'DISCONNECTED' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://evolution.internal:8080/instance/create');
    expect(requests[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      instanceName: upstreamInstanceKey,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: false,
    });
    expect(new Headers(requests[0]?.init.headers).get('apikey')).toBe(platformSecret);
    expect(new Headers(requests[0]?.init.headers).get('x-request-id')).toBe(context.requestId);
    expect(JSON.stringify(result)).not.toContain(platformSecret);
    expect(JSON.stringify(result)).not.toContain('hash');
    expect(JSON.stringify(result)).not.toContain('ignoredByJrc');
  });

  it('normaliza QR Code base64 e data URL com expiração curta', async () => {
    const base64 = createAdapter([jsonResponse(evolutionFixtures.qrCode)]);
    await expect(base64.adapter.beginConnection(context, {
      reference: { id: upstreamInstanceKey },
    })).resolves.toEqual({
      type: 'QR_CODE',
      encoding: 'BASE64',
      value: 'YWJj',
      expiresAt: fixedExpiry,
    });

    const dataUrl = createAdapter([jsonResponse({
      qrcode: { base64: 'data:image/png;base64,YWJj', ignored: 'discard-me' },
    })]);
    await expect(dataUrl.adapter.beginConnection(context, {
      reference: { id: upstreamInstanceKey },
    })).resolves.toEqual({
      type: 'QR_CODE',
      encoding: 'DATA_URL',
      value: 'data:image/png;base64,YWJj',
      expiresAt: fixedExpiry,
    });
  });

  it('normaliza pairing code e envia o hint somente como query codificada', async () => {
    const { adapter, requests } = createAdapter([jsonResponse(evolutionFixtures.pairingCode)]);

    await expect(adapter.beginConnection(context, {
      reference: { id: upstreamInstanceKey },
      pairingHint: '+55 11',
    })).resolves.toEqual({
      type: 'PAIRING_CODE',
      code: '82716490',
      expiresAt: fixedExpiry,
    });
    expect(requests[0]?.url).toBe(
      `http://evolution.internal:8080/instance/connect/${upstreamInstanceKey}?number=%2B55+11`,
    );
    expect(requests[0]?.init.method).toBe('GET');
  });

  it.each([
    [evolutionFixtures.connected, 'ALREADY_CONNECTED'],
    [evolutionFixtures.connecting, 'CONNECTION_PENDING'],
    [{ count: 0 }, 'CONNECTION_PENDING'],
    [{ qrcode: { count: 0 } }, 'CONNECTION_PENDING'],
    [{ instance: { state: 'close' } }, 'NO_USER_ACTION_REQUIRED'],
  ] as const)('normaliza resposta sem desafio como NONE (%s)', async (fixture, reason) => {
    const { adapter } = createAdapter([jsonResponse(fixture)]);
    await expect(adapter.beginConnection(context, {
      reference: { id: upstreamInstanceKey },
    })).resolves.toEqual({ type: 'NONE', reason });
  });

  it.each([
    ['open', 'CONNECTED'],
    ['connecting', 'CONNECTING'],
    ['close', 'DISCONNECTED'],
    ['created', 'CREATED'],
    ['unexpected-upstream-state', 'ERROR'],
  ] as const)('normaliza estado %s para %s', async (state, expected) => {
    const { adapter, requests } = createAdapter([jsonResponse({ instance: { state } })]);
    await expect(adapter.getStatus(context, { id: upstreamInstanceKey })).resolves.toBe(expected);
    expect(requests[0]?.url).toBe(
      `http://evolution.internal:8080/instance/connectionState/${upstreamInstanceKey}`,
    );
    expect(requests[0]?.init.method).toBe('GET');
  });

  it('faz disconnect sem devolver o corpo interno', async () => {
    const { adapter, requests } = createAdapter([jsonResponse(evolutionFixtures.mutationSuccess)]);
    await expect(adapter.disconnect(context, { id: upstreamInstanceKey })).resolves.toBeUndefined();
    expect(requests[0]?.url).toBe(
      `http://evolution.internal:8080/instance/logout/${upstreamInstanceKey}`,
    );
    expect(requests[0]?.init.method).toBe('DELETE');
  });

  it('lookup é somente leitura, filtra por instanceName e descarta credenciais e PII upstream', async () => {
    const { adapter, requests } = createAdapter([jsonResponse(evolutionFixtures.fetched)]);
    const result = await adapter.lookupInstance(context, { id: upstreamInstanceKey });

    expect(result).toEqual({
      exists: true,
      reference: { id: upstreamInstanceKey },
      status: 'CONNECTED',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `http://evolution.internal:8080/instance/fetchInstances?instanceName=${upstreamInstanceKey}`,
    );
    expect(requests[0]?.init.method).toBe('GET');
    expect(requests[0]?.init.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/token|ownerJid|5511999999999|must-not-escape/);
  });

  it('lookup traduz lista vazia e 404 para ausência sem tentar mutação', async () => {
    const empty = createAdapter([jsonResponse([])]);
    await expect(empty.adapter.lookupInstance(context, { id: upstreamInstanceKey }))
      .resolves.toEqual({ exists: false });
    expect(empty.requests).toHaveLength(1);

    const missing = createAdapter([jsonResponse({ message: 'not found' }, 404)]);
    await expect(missing.adapter.lookupInstance(context, { id: upstreamInstanceKey }))
      .resolves.toEqual({ exists: false });
    expect(missing.requests).toHaveLength(1);
    expect(missing.requests[0]?.init.method).toBe('GET');
  });

  it('reconcilia uma instância existente sem reprovisionar', async () => {
    const { adapter, requests } = createAdapter([jsonResponse(evolutionFixtures.fetched)]);
    await expect(adapter.reconcileProvisioning(context, {
      upstreamInstanceKey,
      providerAccountId: '7c0766da-2524-443a-a45b-ab3de2a49b1f',
    })).resolves.toEqual({
      outcome: 'FOUND',
      instance: { reference: { id: upstreamInstanceKey }, status: 'CONNECTED' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init.method).toBe('GET');
  });

  it('reconcilia ausência reprovisionando uma única vez com a mesma chave', async () => {
    const { adapter, requests } = createAdapter([
      jsonResponse([]),
      jsonResponse(evolutionFixtures.created, 201),
    ]);
    await expect(adapter.reconcileProvisioning(context, {
      upstreamInstanceKey,
      providerAccountId: '7c0766da-2524-443a-a45b-ab3de2a49b1f',
    })).resolves.toEqual({
      outcome: 'PROVISIONED',
      instance: { reference: { id: upstreamInstanceKey }, status: 'DISCONNECTED' },
    });
    expect(requests.map(({ init }) => init.method)).toEqual(['GET', 'POST']);
    expect(JSON.parse(String(requests[1]?.init.body)).instanceName).toBe(upstreamInstanceKey);
  });

  it('remove e confirma ausência somente com polling read-only após o endpoint delete', async () => {
    const { adapter, requests } = createAdapter([
      jsonResponse(evolutionFixtures.mutationSuccess),
      jsonResponse(evolutionFixtures.fetched),
      jsonResponse([]),
    ]);
    await expect(adapter.deprovisionInstance(context, { id: upstreamInstanceKey }))
      .resolves.toBeUndefined();
    expect(requests[0]?.url).toBe(
      `http://evolution.internal:8080/instance/delete/${upstreamInstanceKey}`,
    );
    expect(requests.map(({ init }) => init.method)).toEqual(['DELETE', 'GET', 'GET']);
    expect(requests.slice(1).map(({ url }) => url)).toEqual([
      `http://evolution.internal:8080/instance/fetchInstances?instanceName=${upstreamInstanceKey}`,
      `http://evolution.internal:8080/instance/fetchInstances?instanceName=${upstreamInstanceKey}`,
    ]);
  });

  it('encerra o polling de remoção pelo timeout canônico enquanto a instância permanecer', async () => {
    const timeoutAdapter = new EvolutionProviderAdapter({
      baseUrl: 'http://evolution.internal:8080/',
      apiKey: platformSecret,
      fetch: vi.fn(async (_input, init) => {
        if (init?.method === 'DELETE') {
          return jsonResponse(evolutionFixtures.mutationSuccess);
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }),
      now: () => fixedNow,
      challengeTtlMs: 60_000,
      deprovisionPollIntervalMs: 1,
      timeouts: { ...timeouts, deprovisionInstance: 5 },
    });

    await expect(timeoutAdapter.deprovisionInstance(context, { id: upstreamInstanceKey }))
      .rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', message: 'PROVIDER_TIMEOUT' });
  });

  it('usa timeouts distintos e AbortSignal.any em todas as operações', async () => {
    const observedTimeouts: number[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      observedTimeouts.push(milliseconds);
      return new AbortController().signal;
    });
    const { adapter } = createAdapter([
      jsonResponse(evolutionFixtures.created, 201),
      jsonResponse(evolutionFixtures.qrCode),
      jsonResponse(evolutionFixtures.statusOpen),
      jsonResponse(evolutionFixtures.mutationSuccess),
      jsonResponse(evolutionFixtures.fetched),
      jsonResponse(evolutionFixtures.fetched),
      jsonResponse(evolutionFixtures.mutationSuccess),
      jsonResponse([]),
    ]);

    try {
      await adapter.provisionInstance(context, { upstreamInstanceKey, providerAccountId: 'account' });
      await adapter.beginConnection(context, { reference: { id: upstreamInstanceKey } });
      await adapter.getStatus(context, { id: upstreamInstanceKey });
      await adapter.disconnect(context, { id: upstreamInstanceKey });
      await adapter.lookupInstance(context, { id: upstreamInstanceKey });
      await adapter.reconcileProvisioning(context, { upstreamInstanceKey, providerAccountId: 'account' });
      await adapter.deprovisionInstance(context, { id: upstreamInstanceKey });
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(observedTimeouts).toEqual(Object.values(timeouts));
  });

  it('transforma timeout, cancelamento, HTTP inválido e resposta malformada em erros canônicos sanitizados', async () => {
    const timeout = createAdapter([
      (_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    ]);
    await expect(timeout.adapter.getStatus({
      ...context,
      deadline: new Date(fixedNow.getTime() + 1),
    }, { id: upstreamInstanceKey })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      message: 'PROVIDER_TIMEOUT',
    });

    const controller = new AbortController();
    controller.abort(new Error('secret caller abort reason'));
    const aborted = createAdapter([jsonResponse(evolutionFixtures.statusOpen)]);
    await expect(aborted.adapter.getStatus({ ...context, signal: controller.signal }, {
      id: upstreamInstanceKey,
    })).rejects.toMatchObject({ code: 'PROVIDER_ABORTED', message: 'PROVIDER_ABORTED' });
    expect(aborted.requests).toHaveLength(0);

    const failed = createAdapter([jsonResponse({
      message: `upstream failed and leaked ${platformSecret}`,
    }, 500)]);
    const failure = await failed.adapter.getStatus(context, { id: upstreamInstanceKey })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PROVIDER_REQUEST_FAILED', message: 'PROVIDER_REQUEST_FAILED' });
    expect(JSON.stringify(failure)).not.toContain(platformSecret);

    const malformed = createAdapter([jsonResponse({ instance: { state: 123 } })]);
    await expect(malformed.adapter.getStatus(context, { id: upstreamInstanceKey }))
      .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE', message: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('bloqueia redirect same-origin antes de encaminhar o header administrativo', async () => {
    const received: Array<{ path: string | undefined; apiKey: string | undefined }> = [];
    const { server, baseUrl } = await listen((request, response) => {
      received.push({
        path: request.url,
        apiKey: request.headers.apikey as string | undefined,
      });
      if (request.url?.startsWith('/instance/connectionState/')) {
        response.writeHead(302, { location: '/redirected' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(evolutionFixtures.statusOpen));
    });

    try {
      const adapter = new EvolutionProviderAdapter({ baseUrl, apiKey: platformSecret });
      const failure = await adapter.getStatus(context, { id: upstreamInstanceKey })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'PROVIDER_REQUEST_FAILED',
        message: 'PROVIDER_REQUEST_FAILED',
      });
      expect(JSON.stringify(failure)).not.toContain(platformSecret);
      expect(received).toEqual([{
        path: `/instance/connectionState/${upstreamInstanceKey}`,
        apiKey: platformSecret,
      }]);
    } finally {
      await close(server);
    }
  });

  it('bloqueia redirect cross-origin sem fazer request ou vazar o header no destino', async () => {
    const targetRequests: Array<string | undefined> = [];
    const target = await listen((request, response) => {
      targetRequests.push(request.headers.apikey as string | undefined);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(evolutionFixtures.statusOpen));
    });
    const originRequests: Array<string | undefined> = [];
    const origin = await listen((request, response) => {
      originRequests.push(request.headers.apikey as string | undefined);
      response.writeHead(302, { location: `${target.baseUrl}redirected` }).end();
    });

    try {
      const adapter = new EvolutionProviderAdapter({
        baseUrl: origin.baseUrl,
        apiKey: platformSecret,
      });
      const failure = await adapter.getStatus(context, { id: upstreamInstanceKey })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'PROVIDER_REQUEST_FAILED',
        message: 'PROVIDER_REQUEST_FAILED',
      });
      expect(JSON.stringify(failure)).not.toContain(platformSecret);
      expect(originRequests).toEqual([platformSecret]);
      expect(targetRequests).toEqual([]);
    } finally {
      await close(origin.server);
      await close(target.server);
    }
  });

  it('classifica timeout ocorrido durante response.text como PROVIDER_TIMEOUT', async () => {
    const adapter = new EvolutionProviderAdapter({
      baseUrl: 'http://evolution.internal:8080/',
      apiKey: platformSecret,
      fetch: vi.fn(async (_input, init) => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          const rejectOnAbort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener('abort', rejectOnAbort, { once: true });
          if (init?.signal?.aborted === true) rejectOnAbort();
        }),
      }) as Response),
      now: () => fixedNow,
      timeouts: { getStatus: 5 },
    });

    await expect(adapter.getStatus(context, { id: upstreamInstanceKey }))
      .rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', message: 'PROVIDER_TIMEOUT' });
  });

  it('classifica abort externo durante response.text de uma mutação sem repetir o request', async () => {
    const controller = new AbortController();
    let bodyStartedResolve: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyStartedResolve = resolve;
    });
    const fetch = vi.fn(async (_input, init) => ({
      ok: true,
      status: 200,
      text: () => {
        bodyStartedResolve?.();
        return new Promise<string>((_resolve, reject) => {
          const rejectOnAbort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener('abort', rejectOnAbort, { once: true });
          if (init?.signal?.aborted === true) rejectOnAbort();
        });
      },
    }) as Response);
    const adapter = new EvolutionProviderAdapter({
      baseUrl: 'http://evolution.internal:8080/',
      apiKey: platformSecret,
      fetch,
      now: () => fixedNow,
    });

    const pending = adapter.disconnect({ ...context, signal: controller.signal }, {
      id: upstreamInstanceKey,
    });
    await bodyStarted;
    controller.abort(new Error(`caller reason ${platformSecret}`));
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PROVIDER_ABORTED', message: 'PROVIDER_ABORTED' });
    expect(JSON.stringify(failure)).not.toContain(platformSecret);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('classifica falha não relacionada a abort na leitura do body como resposta inválida', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => { throw new Error(`invalid body ${platformSecret}`); },
    }) as Response);
    const adapter = new EvolutionProviderAdapter({
      baseUrl: 'http://evolution.internal:8080/',
      apiKey: platformSecret,
      fetch,
      now: () => fixedNow,
    });
    const failure = await adapter.getStatus(context, { id: upstreamInstanceKey })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      message: 'PROVIDER_INVALID_RESPONSE',
    });
    expect(JSON.stringify(failure)).not.toContain(platformSecret);
  });

  it('rejeita configuração insegura sem colocar segredo ou URL no erro', () => {
    for (const baseUrl of [
      'ftp://evolution.internal',
      'http://user:pass@evolution.internal',
      'http://evolution.internal/base-path?apikey=leaked',
    ]) {
      const failure = (() => {
        try {
          return new EvolutionProviderAdapter({
            baseUrl,
            apiKey: platformSecret,
            fetch: vi.fn(),
          });
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toMatchObject({
        code: 'INVALID_EVOLUTION_CONFIGURATION',
        message: 'INVALID_EVOLUTION_CONFIGURATION',
      });
    }

    let invalidTtlFailure: unknown;
    try {
      new EvolutionProviderAdapter({
        baseUrl: 'http://evolution.internal',
        apiKey: platformSecret,
        fetch: vi.fn(),
        challengeTtlMs: 0,
      });
    } catch (error) {
      invalidTtlFailure = error;
    }
    expect(invalidTtlFailure).toMatchObject({
      code: 'INVALID_EVOLUTION_CONFIGURATION',
      message: 'INVALID_EVOLUTION_CONFIGURATION',
    });
  });
});
