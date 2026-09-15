import { describe, expect, it, vi } from 'vitest';

import {
  createPinnedTypebotFetch,
  TypebotClient,
  TypebotClientError,
  type TypebotFetch,
  type TypebotPinnedDispatch,
} from '../src/typebot/client.js';

const origin = 'https://chat.example.com';
const tokenCanary = 'protected-typebot-token-canary';

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

function createClient(fetch: TypebotFetch, overrides: Partial<{
  accessToken: string;
  allowedOrigins: readonly string[];
  maxResponseBytes: number;
  origin: string;
  timeoutMs: number;
}> = {}): TypebotClient {
  return new TypebotClient({
    origin,
    allowedOrigins: [origin],
    fetch,
    timeoutMs: 100,
    maxResponseBytes: 8_192,
    ...overrides,
  });
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(TypebotClientError);
  expect((error as TypebotClientError).code).toBe(code);
}

describe('TypebotClient', () => {
  it('resolves and pins the default HTTPS transport to a validated public address', async () => {
    const response = jsonResponse({ sessionId: 'session-pinned', messages: [] });
    const dispatch: TypebotPinnedDispatch = vi.fn(async () => response);
    const lookup = vi.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 as const },
    ]);
    const fetch = createPinnedTypebotFetch({ dispatch, lookup });

    await expect(fetch('https://chat.example.com:8443/api/v1/typebots/welcome/startChat', {
      method: 'POST',
      body: '{}',
      headers: { authorization: `Bearer ${tokenCanary}` },
      redirect: 'error',
    })).resolves.toBe(response);

    expect(lookup).toHaveBeenCalledWith('chat.example.com');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      address: '93.184.216.34',
      family: 4,
      hostHeader: 'chat.example.com:8443',
      servername: 'chat.example.com',
      url: new URL('https://chat.example.com:8443/api/v1/typebots/welcome/startChat'),
    }));
  });

  it.each([
    [{ address: '127.0.0.1', family: 4 as const }],
    [{ address: '169.254.169.254', family: 4 as const }],
    [{ address: '::1', family: 6 as const }],
    [
      { address: '93.184.216.34', family: 4 as const },
      { address: '10.0.0.1', family: 4 as const },
    ],
  ])('refuses DNS answers containing a non-public destination: %o', async (...addresses) => {
    const dispatch: TypebotPinnedDispatch = vi.fn(async () => jsonResponse({ messages: [] }));
    const fetch = createPinnedTypebotFetch({
      dispatch,
      lookup: async () => addresses,
    });

    await expect(fetch('https://chat.example.com/api/v1/typebots/welcome/startChat'))
      .rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('starts a public chat with the official endpoint and an optional text answer', async () => {
    const requests: RecordedRequest[] = [];
    const fetch: TypebotFetch = vi.fn(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ sessionId: 'session-1', messages: [] });
    });
    const client = createClient(fetch, { accessToken: tokenCanary });

    await expect(client.startChat('public/bot', 'Olá')).resolves.toEqual({
      sessionId: 'session-1',
      texts: [],
      incompatibilities: [],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://chat.example.com/api/v1/typebots/public%2Fbot/startChat',
    );
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.redirect).toBe('error');
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new Headers(requests[0]?.init.headers).entries())).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${tokenCanary}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      message: { type: 'text', text: 'Olá' },
      textBubbleContentFormat: 'markdown',
    });
  });

  it('omits the message when startChat has no initial answer and needs no token', async () => {
    let request: RecordedRequest | undefined;
    const fetch: TypebotFetch = async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return jsonResponse({ sessionId: 'session-2', messages: [] });
    };

    await createClient(fetch).startChat('welcome');

    expect(new Headers(request?.init.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(request?.init.body))).toEqual({
      textBubbleContentFormat: 'markdown',
    });
  });

  it('continues the caller-owned session without changing its identity', async () => {
    let request: RecordedRequest | undefined;
    const fetch: TypebotFetch = async (input, init) => {
      request = { url: String(input), init: init ?? {} };
      return jsonResponse({ messages: [] });
    };

    await expect(createClient(fetch).continueChat('session/tenant-a', 'sim')).resolves.toEqual({
      sessionId: 'session/tenant-a',
      texts: [],
      incompatibilities: [],
    });

    expect(request?.url).toBe(
      'https://chat.example.com/api/v1/sessions/session%2Ftenant-a/continueChat',
    );
    expect(JSON.parse(String(request?.init.body))).toEqual({
      message: { type: 'text', text: 'sim' },
      textBubbleContentFormat: 'markdown',
    });
  });

  it('keeps text bubbles ordered and exposes safe incompatibility metadata', async () => {
    const fetch: TypebotFetch = async () => jsonResponse({
      sessionId: 'session-3',
      messages: [
        { id: 'text-1', type: 'text', content: { type: 'markdown', markdown: 'Primeiro' } },
        { id: 'image-1', type: 'image', content: { url: 'https://cdn.example/secret.jpg' } },
        { id: 'text-2', type: 'text', content: { type: 'markdown', markdown: '**Segundo**' } },
        { id: 'embed-1', type: 'custom-embed', content: { initFunction: { content: 'secret()' } } },
      ],
      input: {
        id: 'choice-1',
        type: 'buttons input',
        options: { items: [{ id: 'private-choice', content: 'Sensitive label' }] },
      },
      clientSideActions: [
        {
          type: 'scriptToExecute',
          scriptToExecute: { content: 'stealCredentials()', args: [] },
        },
      ],
    });

    await expect(createClient(fetch).startChat('welcome')).resolves.toEqual({
      sessionId: 'session-3',
      texts: ['Primeiro', '**Segundo**'],
      input: { id: 'choice-1', type: 'buttons input' },
      incompatibilities: [
        { kind: 'UNSUPPORTED_MESSAGE', id: 'image-1', type: 'image' },
        { kind: 'UNSUPPORTED_MESSAGE', id: 'embed-1', type: 'custom-embed' },
        { kind: 'UNSUPPORTED_INPUT', id: 'choice-1', type: 'buttons input' },
        { kind: 'CLIENT_SIDE_ACTION', type: 'scriptToExecute' },
      ],
    });
  });

  it('returns supported text input information without marking it incompatible', async () => {
    const fetch: TypebotFetch = async () => jsonResponse({
      messages: [],
      input: { id: 'answer-1', type: 'text input', options: { variableId: 'secret-variable' } },
    });

    await expect(createClient(fetch).continueChat('session-4', 'next')).resolves.toEqual({
      sessionId: 'session-4',
      texts: [],
      input: { id: 'answer-1', type: 'text input' },
      incompatibilities: [],
    });
  });

  it.each([
    'http://chat.example.com',
    'https://user:password@chat.example.com',
    'https://chat.example.com/api',
    'https://chat.example.com?tenant=a',
    'https://chat.example.com#fragment',
    'https://localhost',
    'https://localhost.',
    'https://service.localhost.',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://172.20.1.2',
    'https://192.168.1.2',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[fd00::1]',
    'https://[fe80::1]',
  ])('rejects hostile origin %s before fetch', async (hostileOrigin) => {
    const fetch: TypebotFetch = vi.fn(async () => jsonResponse({ messages: [] }));

    expect(() => createClient(fetch, {
      origin: hostileOrigin,
      allowedOrigins: [hostileOrigin],
    })).toThrowError(TypebotClientError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a safe origin absent from the server allowlist', () => {
    const fetch: TypebotFetch = vi.fn(async () => jsonResponse({ messages: [] }));

    expect(() => createClient(fetch, {
      allowedOrigins: ['https://other.example.com'],
    })).toThrowError(TypebotClientError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps a missing continueChat session to SESSION_EXPIRED without exposing the body', async () => {
    const secretBody = 'upstream-secret-body-canary';
    const fetch: TypebotFetch = async () => new Response(secretBody, { status: 404 });

    const error = await createClient(fetch).continueChat('expired', 'hello').catch((caught) => caught);

    expectCode(error, 'SESSION_EXPIRED');
    expect(String(error)).not.toContain(secretBody);
  });

  it('returns UNKNOWN once when a dispatched POST has an uncertain network result', async () => {
    const fetch: TypebotFetch = vi.fn(async () => {
      throw new Error(`socket closed ${tokenCanary}`);
    });

    const error = await createClient(fetch).startChat('welcome').catch((caught) => caught);

    expectCode(error, 'UNKNOWN');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(error)).not.toContain(tokenCanary);
  });

  it('returns UNKNOWN once for a 5xx response because the POST outcome is uncertain', async () => {
    const fetch: TypebotFetch = vi.fn(async () => new Response('upstream failed', { status: 503 }));

    const error = await createClient(fetch).startChat('welcome').catch((caught) => caught);

    expectCode(error, 'UNKNOWN');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['', 'INVALID_CONFIGURATION'],
    ['x'.repeat(4_097), 'INVALID_CONFIGURATION'],
    ['é'.repeat(2_049), 'INVALID_CONFIGURATION'],
    [42, 'INVALID_CONFIGURATION'],
  ])('rejects an invalid runtime access token before fetch: %o', (accessToken, code) => {
    const fetch: TypebotFetch = vi.fn(async () => jsonResponse({ messages: [] }));

    let error: unknown;
    try {
      new TypebotClient({
        origin,
        allowedOrigins: [origin],
        fetch,
        accessToken,
      } as unknown as ConstructorParameters<typeof TypebotClient>[0]);
    } catch (caught) {
      error = caught;
    }

    expectCode(error, code);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['start id', (client: TypebotClient) => client.startChat('x'.repeat(513))],
    ['start id UTF-8 bytes', (client: TypebotClient) => client.startChat('é'.repeat(257))],
    ['start id type', (client: TypebotClient) => client.startChat(42 as unknown as string)],
    ['continue id', (client: TypebotClient) => client.continueChat('x'.repeat(513), 'hello')],
    ['start text', (client: TypebotClient) => client.startChat('welcome', 'x'.repeat(4_097))],
    ['start text UTF-8 bytes', (client: TypebotClient) => client.startChat('welcome', '🙂'.repeat(1_025))],
    ['continue text', (client: TypebotClient) => client.continueChat('session', 'x'.repeat(4_097))],
    ['continue text type', (client: TypebotClient) => client.continueChat('session', 42 as unknown as string)],
  ])('bounds runtime %s before dispatch', async (_case, invoke) => {
    const fetch: TypebotFetch = vi.fn(async () => jsonResponse({ messages: [] }));

    const error = await invoke(createClient(fetch)).catch((caught) => caught);

    expectCode(error, 'INVALID_ARGUMENT');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts a timed-out POST, returns UNKNOWN, and never retries', async () => {
    let signal: AbortSignal | undefined;
    const fetch: TypebotFetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const error = await createClient(fetch, { timeoutMs: 10 })
      .continueChat('session-5', 'slow')
      .catch((caught) => caught);

    expectCode(error, 'UNKNOWN');
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds the streamed response body even without content-length', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"messages":['));
        controller.enqueue(encoder.encode(`"${'x'.repeat(100)}"`));
        controller.close();
      },
    });
    const fetch: TypebotFetch = async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const error = await createClient(fetch, { maxResponseBytes: 32 })
      .continueChat('session-6', 'large')
      .catch((caught) => caught);

    expectCode(error, 'RESPONSE_TOO_LARGE');
  });

  it('cancels an advertised oversized body before reading it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const fetch: TypebotFetch = async () => new Response(body, {
      status: 200,
      headers: {
        'content-length': '1000',
        'content-type': 'application/json',
      },
    });

    const error = await createClient(fetch, { maxResponseBytes: 32 })
      .continueChat('session-advertised-large', 'hello')
      .catch((caught) => caught);

    expectCode(error, 'RESPONSE_TOO_LARGE');
    expect(cancelled).toBe(true);
  });

  it('returns UNKNOWN once when the response stream breaks after the POST is accepted', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"messages":'));
        controller.error(new Error(`stream failed ${tokenCanary}`));
      },
    });
    const fetch: TypebotFetch = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await createClient(fetch)
      .continueChat('session-stream', 'hello')
      .catch((caught) => caught);

    expectCode(error, 'UNKNOWN');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(error)).not.toContain(tokenCanary);
  });

  it.each([
    new Response('<html>proxy error</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    jsonResponse({ messages: 'not-an-array' }),
    jsonResponse({ sessionId: '', messages: [] }),
    jsonResponse({
      sessionId: 'session-7',
      messages: [{ id: 'bad-text', type: 'text', content: { type: 'markdown', markdown: 42 } }],
    }),
  ])('rejects malformed successful responses without exposing response content', async (response) => {
    const fetch: TypebotFetch = async () => response.clone();

    const error = await createClient(fetch).startChat('welcome').catch((caught) => caught);

    expectCode(error, 'INVALID_RESPONSE');
    expect(String(error)).not.toContain('proxy error');
    expect(String(error)).not.toContain('bad-text');
  });

  it('treats redirects as upstream failures and always disables fetch redirects', async () => {
    let redirect: RequestRedirect | undefined;
    const fetch: TypebotFetch = async (_input, init) => {
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://internal.example/metadata' },
      });
    };

    const error = await createClient(fetch).startChat('welcome').catch((caught) => caught);

    expectCode(error, 'UPSTREAM_ERROR');
    expect(redirect).toBe('error');
  });
});
