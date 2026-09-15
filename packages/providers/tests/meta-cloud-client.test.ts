import { describe, expect, it, vi } from 'vitest';

import {
  MetaCloudClient,
  type MetaCloudFetch,
} from '../src/meta/cloud-client.js';

const options = {
  accessToken: 'server-owned-token',
  graphVersion: 'v23.0',
  phoneNumberId: '123456789012345',
  wabaId: '987654321098765',
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MetaCloudClient configuration', () => {
  it.each([
    [{ ...options, graphVersion: 'latest' }],
    [{ ...options, graphVersion: 'v23.0/../../me' }],
    [{ ...options, phoneNumberId: 'phone-1' }],
    [{ ...options, wabaId: 'https://attacker.invalid' }],
    [{ ...options, accessToken: '' }],
    [{ ...options, accessToken: 'token\nX-Injected: yes' }],
    [{ ...options, timeoutMs: 0 }],
    [{ ...options, maxResponseBytes: 0 }],
    [{ ...options, maxTemplatePages: 0 }],
  ])('rejects invalid server configuration without exposing its value', (invalid) => {
    expect(() => new MetaCloudClient(invalid)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_META_CONFIGURATION',
        message: 'INVALID_META_CONFIGURATION',
      }),
    );
  });
});

describe('MetaCloudClient sends', () => {
  it('sends text to the fixed Graph host and returns an acceptance, not delivery', async () => {
    const fetch = vi.fn<MetaCloudFetch>().mockResolvedValue(jsonResponse({
      messaging_product: 'whatsapp',
      contacts: [{ input: '5511999999999', wa_id: '5511999999999' }],
      messages: [{ id: 'wamid.accepted-1' }],
    }));
    const client = new MetaCloudClient({ ...options, fetch });

    const result = await client.sendText('5511999999999', 'Olá');

    expect(result).toEqual({ status: 'ACCEPTED', upstreamMessageId: 'wamid.accepted-1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      'https://graph.facebook.com/v23.0/123456789012345/messages',
    );
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer server-owned-token',
    );
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999999999',
      type: 'text',
      text: { body: 'Olá' },
    });
  });

  it('sends a template with language and optional components', async () => {
    const fetch = vi.fn<MetaCloudFetch>().mockResolvedValue(jsonResponse({
      messaging_product: 'whatsapp',
      contacts: [{ input: '5511999999999', wa_id: '5511999999999' }],
      messages: [{ id: 'wamid.accepted-2' }],
    }));
    const client = new MetaCloudClient({ ...options, fetch });

    await client.sendTemplate('5511999999999', {
      name: 'pedido_pronto',
      language: 'pt_BR',
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: '42' }],
      }],
    });

    const [, init] = fetch.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999999999',
      type: 'template',
      template: {
        name: 'pedido_pronto',
        language: { code: 'pt_BR' },
        components: [{
          type: 'body',
          parameters: [{ type: 'text', text: '42' }],
        }],
      },
    });
  });

  it.each([
    ['invalid recipient', (client: MetaCloudClient) => client.sendText('not-a-number', 'hello')],
    ['empty text', (client: MetaCloudClient) => client.sendText('5511999999999', '')],
    ['oversized text', (client: MetaCloudClient) => client.sendText('5511999999999', 'x'.repeat(4_097))],
    ['invalid template name', (client: MetaCloudClient) => client.sendTemplate(
      '5511999999999',
      { name: 'UPPERCASE', language: 'pt_BR' },
    )],
    ['invalid template language', (client: MetaCloudClient) => client.sendTemplate(
      '5511999999999',
      { name: 'pedido_pronto', language: '../pt_BR' },
    )],
    ['non-JSON template components', (client: MetaCloudClient) => {
      const component: Record<string, unknown> = { type: 'body' };
      component.self = component;
      return client.sendTemplate(
        '5511999999999',
        { name: 'pedido_pronto', language: 'pt_BR', components: [component] },
      );
    }],
  ])('rejects %s before a request is attempted', async (_case, invoke) => {
    const fetch = vi.fn<MetaCloudFetch>();
    const client = new MetaCloudClient({ ...options, fetch });

    await expect(invoke(client)).rejects.toMatchObject({ code: 'INVALID_META_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a network failure', () => Promise.reject(new Error('socket included-secret'))],
    ['a 5xx response', () => Promise.resolve(new Response('sensitive upstream body', { status: 503 }))],
    ['a malformed 2xx response', () => Promise.resolve(jsonResponse({ messages: [] }))],
  ])('maps %s to UNKNOWN without retry or leaked details', async (_case, behavior) => {
    const fetch = vi.fn<MetaCloudFetch>().mockImplementation(behavior);
    const client = new MetaCloudClient({ ...options, fetch });

    const rejection = client.sendText('5511999999999', 'hello');

    await expect(rejection).rejects.toMatchObject({
      code: 'META_SEND_UNKNOWN',
      message: 'META_SEND_UNKNOWN',
    });
    await expect(rejection).rejects.not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps timeout to UNKNOWN and aborts the single request', async () => {
    const fetch = vi.fn<MetaCloudFetch>().mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    ));
    const client = new MetaCloudClient({ ...options, fetch, timeoutMs: 5 });

    await expect(client.sendText('5511999999999', 'hello')).rejects.toMatchObject({
      code: 'META_SEND_UNKNOWN',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a bounded-response overflow after POST as UNKNOWN', async () => {
    const fetch = vi.fn<MetaCloudFetch>().mockResolvedValue(new Response('x'.repeat(129), {
      status: 200,
    }));
    const client = new MetaCloudClient({ ...options, fetch, maxResponseBytes: 128 });

    await expect(client.sendText('5511999999999', 'hello')).rejects.toMatchObject({
      code: 'META_SEND_UNKNOWN',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps a definite 4xx rejection without leaking the response body', async () => {
    const fetch = vi.fn<MetaCloudFetch>().mockResolvedValue(
      new Response('customer payload and server-owned-token', { status: 400 }),
    );
    const client = new MetaCloudClient({ ...options, fetch });

    const rejection = client.sendText('5511999999999', 'hello');

    await expect(rejection).rejects.toMatchObject({
      code: 'META_REQUEST_REJECTED',
      message: 'META_REQUEST_REJECTED',
    });
    await expect(rejection).rejects.not.toHaveProperty('cause');
  });
});

describe('MetaCloudClient template listing', () => {
  it('paginates with validated cursors on the fixed host and ignores provider next URLs', async () => {
    const fetch = vi.fn<MetaCloudFetch>()
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: '10001',
          name: 'pedido_pronto',
          language: 'pt_BR',
          status: 'APPROVED',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Pedido {{1}} pronto' }],
        }],
        paging: {
          cursors: { before: 'before-1', after: 'cursor /+= 2' },
          next: 'https://attacker.invalid/steal-token',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: [{
          id: '10002',
          name: 'boas_vindas',
          language: 'pt_BR',
          status: 'PAUSED',
          category: 'MARKETING',
          components: [],
        }],
        paging: { cursors: { before: 'before-2', after: 'unused-last-cursor' } },
      }));
    const client = new MetaCloudClient({ ...options, fetch });

    const templates = await client.listTemplates();

    expect(templates).toEqual([
      {
        id: '10001',
        name: 'pedido_pronto',
        language: 'pt_BR',
        status: 'APPROVED',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Pedido {{1}} pronto' }],
      },
      {
        id: '10002',
        name: 'boas_vindas',
        language: 'pt_BR',
        status: 'PAUSED',
        category: 'MARKETING',
        components: [],
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://graph.facebook.com/v23.0/987654321098765/message_templates?limit=100',
    );
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      'https://graph.facebook.com/v23.0/987654321098765/message_templates?limit=100&after=cursor+%2F%2B%3D+2',
    );
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer server-owned-token',
      );
      expect(init?.redirect).toBe('error');
    }
  });

  it.each([
    ['malformed template data', { data: [{ id: '10001', name: '' }] }],
    ['an oversized cursor', {
      data: [],
      paging: { cursors: { after: 'x'.repeat(2_049) }, next: 'https://graph.facebook.com/next' },
    }],
  ])('rejects %s as an invalid provider response', async (_case, body) => {
    const fetch = vi.fn<MetaCloudFetch>().mockResolvedValue(jsonResponse(body));
    const client = new MetaCloudClient({ ...options, fetch });

    await expect(client.listTemplates()).rejects.toMatchObject({
      code: 'META_INVALID_RESPONSE',
      message: 'META_INVALID_RESPONSE',
    });
  });

  it('rejects a repeated pagination cursor instead of looping', async () => {
    const page = {
      data: [],
      paging: {
        cursors: { after: 'same-cursor' },
        next: 'https://graph.facebook.com/ignored',
      },
    };
    const fetch = vi.fn<MetaCloudFetch>().mockResolvedValue(jsonResponse(page));
    const client = new MetaCloudClient({ ...options, fetch });

    await expect(client.listTemplates()).rejects.toMatchObject({
      code: 'META_INVALID_RESPONSE',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds the number of template pages', async () => {
    const fetch = vi.fn<MetaCloudFetch>().mockImplementation(async (input) => {
      const cursor = new URL(String(input)).searchParams.get('after') ?? 'first';
      return jsonResponse({
        data: [],
        paging: {
          cursors: { after: `after-${cursor}` },
          next: 'https://graph.facebook.com/ignored',
        },
      });
    });
    const client = new MetaCloudClient({ ...options, fetch, maxTemplatePages: 2 });

    await expect(client.listTemplates()).rejects.toMatchObject({
      code: 'META_INVALID_RESPONSE',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('bounds GET response bytes before parsing', async () => {
    const fetch = vi.fn<MetaCloudFetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [], padding: 'x'.repeat(200) }), { status: 200 }),
    );
    const client = new MetaCloudClient({ ...options, fetch, maxResponseBytes: 128 });

    await expect(client.listTemplates()).rejects.toMatchObject({
      code: 'META_RESPONSE_TOO_LARGE',
    });
  });
});
