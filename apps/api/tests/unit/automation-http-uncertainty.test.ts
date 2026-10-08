import { describe, expect, it, vi } from 'vitest';
import { AutomationHttpError, createAutomationSafeHttp } from '../../src/modules/automation-integrations/safe-http.js';
import { createAutomationHttpEffectDispatcher, type AutomationHttpEffectOptions } from '../../src/modules/automations/http-effect.js';
import { createOutboxDispatcher } from '../../src/modules/automations/service.js';
import type { AutomationRepository, OutboxRow } from '../../src/modules/automations/repository.js';

const item: OutboxRow = { id: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222',
  executionId: '33333333-3333-4333-8333-333333333333', channelId: '44444444-4444-4444-8444-444444444444', conversationId: '55555555-5555-4555-8555-555555555555',
  nodeId: 'http', ordinal: 1000, kind: 'IO_HTTP', attempts: 1, leaseToken: '66666666-6666-4666-8666-666666666666',
  payload: { method: 'POST', url: 'https://synthetic.example/action', timeoutMs: 10, retryAttempts: 2 } };
const credential = vi.fn(async () => ({ type: 'BEARER' as const, secret: { token: 'synthetic-canary' } }));
describe('HTTP mutation uncertainty barrier', () => {
  it('keeps a timeout after POST dispatch UNKNOWN without resume, settlement or replay', async () => {
    const connect = vi.fn(() => new Promise<Response>(() => {}));
    const audit = vi.fn<AutomationHttpEffectOptions['audit']>(async () => undefined);
    const external = createAutomationHttpEffectDispatcher({ request: createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect }), resolveCredential: credential, audit });
    let available: OutboxRow | null = item;
    const settle = vi.fn(), resume = vi.fn(), recordUnknownOutbox = vi.fn(async () => true);
    const repository = { claimOutbox: vi.fn(async () => { const value = available; available = null; return value; }), settleOutbox: settle, resumeExecution: resume, recordUnknownOutbox } as unknown as AutomationRepository;
    const worker = createOutboxDispatcher({ repository, transact: async (_org, work) => work({} as never) }, external, ['IO_HTTP']);
    expect(await worker.runOnce(item.organizationId)).toMatchObject({ status: 'UNKNOWN' });
    expect(settle).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(recordUnknownOutbox).toHaveBeenCalledWith(expect.anything(), item.organizationId, item.id,
      expect.any(String), 'AUTOMATION_HTTP_TIMEOUT');
    expect(await worker.runOnce(item.organizationId)).toEqual({ processed: false });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(item, 'unknown', expect.any(Number), undefined, { error: 'AUTOMATION_HTTP_TIMEOUT' });
  });
  it('records only a fixed diagnostic for an unrecognized uncertain-effect error', async () => {
    const recordUnknownOutbox = vi.fn(async () => true), settle = vi.fn(), resume = vi.fn();
    const repository = { claimOutbox: async () => item, recordUnknownOutbox, settleOutbox: settle,
      resumeExecution: resume } as unknown as AutomationRepository;
    const worker = createOutboxDispatcher({ repository, transact: async (_org, work) => work({} as never) },
      { dispatch: async () => ({ kind: 'UNKNOWN', error: 'https://credential.example/?token=synthetic-canary' }) }, ['IO_HTTP']);
    expect(await worker.runOnce(item.organizationId)).toMatchObject({ status: 'UNKNOWN' });
    expect(recordUnknownOutbox).toHaveBeenCalledWith(expect.anything(), item.organizationId, item.id,
      expect.any(String), 'AUTOMATION_EFFECT_UNKNOWN');
    expect(JSON.stringify(recordUnknownOutbox.mock.calls)).not.toContain('synthetic-canary');
    expect(settle).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  });
  it('never exposes a generic transport error containing URL, credentials or headers', async () => {
    const audit = vi.fn<AutomationHttpEffectOptions['audit']>(async () => undefined);
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit,
      request: createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect: async () => { throw new Error('https://credential.example/path?token=synthetic-canary Authorization: Bearer synthetic-canary'); } }) });
    const result = await external.dispatch(item);
    expect(result).toEqual({ kind: 'UNKNOWN', error: 'AUTOMATION_HTTP_TRANSPORT_FAILED' });
    expect(JSON.stringify([result, audit.mock.calls])).not.toContain('synthetic-canary');
    expect(JSON.stringify([result, audit.mock.calls])).not.toContain('credential.example');
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('does not retry %s after connector uncertainty', async method => {
    const connect = vi.fn(async (_input: { method: string }) => { throw new Error('synthetic transport interruption'); });
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit: async () => undefined,
      request: createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect }) });
    expect(await external.dispatch({ ...item, payload: { ...item.payload, method, retryAttempts: 99 } }))
      .toEqual({ kind: 'UNKNOWN', error: 'AUTOMATION_HTTP_TRANSPORT_FAILED' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]).toMatchObject({ method });
  });
  it('keeps original POST uncertainty when a same-origin 303 changes the redirected request to GET', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockRejectedValueOnce(new Error('synthetic DNS error'));
    const connect = vi.fn(async () => new Response(null, { status: 303, headers: { location: '/result' } }));
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit: async () => undefined,
      request: createAutomationSafeHttp({ resolve, connect }) });
    expect(await external.dispatch(item)).toEqual({ kind: 'UNKNOWN', error: 'AUTOMATION_HTTP_DNS_FAILED' });
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['cross-origin redirect', async () => new Response(null, { status: 307, headers: { location: 'https://other.example' } }), 'AUTOMATION_HTTP_CROSS_ORIGIN_REDIRECT'],
    ['oversized response', async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'AUTOMATION_HTTP_RESPONSE_LIMIT'],
    ['interrupted response', async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic interruption')); } })), 'AUTOMATION_HTTP_RESPONSE_INVALID'],
  ] as const)('preserves UNKNOWN after POST with %s', async (_scenario, connect, code) => {
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit: async () => undefined,
      request: createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect }) });
    expect(await external.dispatch(item)).toEqual({ kind: 'UNKNOWN', error: code });
  });
  it.each([
    ['DNS timeout', () => new Promise<readonly string[]>(() => {}), {}, 'AUTOMATION_HTTP_TIMEOUT', 'timeout'],
    ['DNS failure', async () => { throw new Error('https://credential.example/?token=synthetic-canary'); }, {}, 'AUTOMATION_HTTP_DNS_FAILED', 'unknown'],
    ['private address', async () => ['127.0.0.1'], {}, 'AUTOMATION_HTTP_SSRF_REJECTED', 'unknown'],
    ['invalid URL', async () => ['8.8.8.8'], { url: 'invalid synthetic-canary' }, 'AUTOMATION_HTTP_URL_REJECTED', 'unknown'],
    ['invalid header', async () => ['8.8.8.8'], { headers: { 'bad header synthetic-canary': 'private' } }, 'AUTOMATION_HTTP_HEADER_REJECTED', 'unknown'],
  ] as const)('uses the failure port for %s proven before dispatch', async (_scenario, resolve, payload, code, outcome) => {
    const connect = vi.fn();
    const audit = vi.fn<AutomationHttpEffectOptions['audit']>(async () => undefined);
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit,
      request: createAutomationSafeHttp({ resolve, connect }) });
    const result = await external.dispatch({ ...item, payload: { ...item.payload, ...payload } });
    expect(result).toEqual({ kind: 'FAILED', error: code, resumePayload: { outcome, output: { error: code } } });
    expect(connect).not.toHaveBeenCalled();
    expect(JSON.stringify([result, audit.mock.calls.map(([_item, ...metadata]) => metadata)])).not.toContain('synthetic-canary');
  });
  it('reports no dispatch when cancellation precedes invocation of the connector', async () => {
    const controller = new AbortController(); controller.abort();
    const clock = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal), connect = vi.fn(), resolve = vi.fn();
    try {
      await expect(createAutomationSafeHttp({ resolve, connect })({ method: 'POST', url: 'https://synthetic.example' }))
        .rejects.toMatchObject({ code: 'AUTOMATION_HTTP_TIMEOUT', dispatched: false });
      expect(resolve).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('bounds GET timeout retries then follows the timeout port without mutation uncertainty', async () => {
    const connect = vi.fn(() => new Promise<Response>(() => {}));
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit: async () => undefined,
      request: createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect }) });
    expect(await external.dispatch({ ...item, payload: { ...item.payload, method: 'GET', retryAttempts: 99 } }))
      .toEqual({ kind: 'FAILED', error: 'AUTOMATION_HTTP_TIMEOUT', resumePayload: { outcome: 'timeout', output: { error: 'AUTOMATION_HTTP_TIMEOUT' } } });
    expect(connect).toHaveBeenCalledTimes(3);
  });
  it.each([200, 400, 503])('preserves completed response ports for POST status %s', async status => {
    const outcome = status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success';
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit: async () => undefined,
      request: createAutomationSafeHttp({ resolve: async () => ['8.8.8.8'], connect: async () => new Response('result', { status }) }) });
    expect(await external.dispatch(item)).toMatchObject({ kind: 'SENT', resumePayload: { outcome, output: { status, body: 'result' } } });
  });
  it('uses only typed pre-dispatch proof, treating an untyped request rejection conservatively', async () => {
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit: async () => undefined,
      request: async () => { throw new Error('AUTOMATION_HTTP_TIMEOUT'); } });
    expect(await external.dispatch(item)).toEqual({ kind: 'UNKNOWN', error: 'AUTOMATION_HTTP_TRANSPORT_FAILED' });
  });
  it('does not dispatch when tenant credential resolution fails and sanitizes its error', async () => {
    const request = vi.fn(), resolveCredential = vi.fn(async () => { throw new Error('credential synthetic-canary'); });
    const external = createAutomationHttpEffectDispatcher({ request, resolveCredential, audit: async () => undefined });
    expect(await external.dispatch({ ...item, payload: { ...item.payload, credentialId: '77777777-7777-4777-8777-777777777777' } }))
      .toEqual({ kind: 'FAILED', error: 'AUTOMATION_HTTP_PREPARATION_FAILED', resumePayload: { outcome: 'unknown', output: { error: 'AUTOMATION_HTTP_PREPARATION_FAILED' } } });
    expect(resolveCredential).toHaveBeenCalledWith(item.organizationId, '77777777-7777-4777-8777-777777777777');
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['completed', 'preflight'] as const)('conserves UNKNOWN if the %s audit cannot be committed', async scenario => {
    const audit = vi.fn(async () => { throw new Error('database synthetic-canary'); });
    const external = createAutomationHttpEffectDispatcher({ resolveCredential: credential, audit,
      request: async () => { if (scenario === 'preflight') throw new AutomationHttpError('AUTOMATION_HTTP_URL_REJECTED', false);
        return { status: 200, headers: {}, body: 'confirmed', bytes: 9, outcome: 'success' }; } });
    expect(await external.dispatch(item)).toEqual({ kind: 'UNKNOWN', error: 'AUTOMATION_HTTP_AUDIT_FAILED' });
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
