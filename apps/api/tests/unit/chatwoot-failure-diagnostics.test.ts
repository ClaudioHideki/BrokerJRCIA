import { describe, expect, it } from 'vitest';
import { ChatwootClient, ChatwootError } from '../../src/modules/integrations/chatwoot-client.js';

const secret = 'SYNTHETIC_PRIVATE_BODY_MUST_NOT_ESCAPE';
function client(fetch: typeof globalThis.fetch) {
  return new ChatwootClient({ baseUrl: 'https://chatwoot.example.test', token: 'synthetic-only-token', fetch });
}
async function failure(work: Promise<unknown>) {
  try { await work; throw new Error('Expected request to fail'); }
  catch (error) { expect(error).toBeInstanceOf(ChatwootError); return error as ChatwootError; }
}

describe('typed Chatwoot failure boundary', () => {
  it.each([401, 403, 422, 429, 500])('preserves bounded HTTP evidence for read rejection %i without response content', async status => {
    const error = await failure(client(async () => new Response(secret, { status })).listInboxes(1));
    expect(error).toMatchObject({
      httpStatus: status, diagnostic: { phase: 'HTTP_STATUS', method: 'GET', httpStatus: status },
      retrySafe: status === 429 || status >= 500, uncertain: false,
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it.each([408, 500, 503])('retains uncertainty for a POST with HTTP %i rather than declaring it unsent', async status => {
    const error = await failure(client(async () => new Response(secret, { status })).createInbox(1, 'Synthetic', 'https://broker.example.test/events'));
    expect(error).toMatchObject({ code: 'CHATWOOT_OUTCOME_UNKNOWN', retrySafe: false, uncertain: true,
      diagnostic: { phase: 'HTTP_STATUS', method: 'POST', httpStatus: status } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it.each(['GET', 'POST'] as const)('keeps the observed HTTP rejection if discarded body cancellation fails (%s)', async method => {
    const remote = client(async () => new Response(new ReadableStream({
      cancel() { throw new Error(secret); },
    }), { status: 503 }));
    const error = await failure(method === 'GET' ? remote.listInboxes(1)
      : remote.createInbox(1, 'Synthetic', 'https://broker.example.test/events'));
    expect(error).toMatchObject({ retrySafe: method === 'GET', uncertain: method === 'POST',
      diagnostic: { phase: 'HTTP_STATUS', method, httpStatus: 503 } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('distinguishes transport failure on a read and an uncertain mutation without logging the network error', async () => {
    const remote = client(async () => { throw new Error(secret); });
    const read = await failure(remote.listInboxes(1));
    const write = await failure(remote.createInbox(1, 'Synthetic', 'https://broker.example.test/events'));
    expect(read).toMatchObject({ retrySafe: true, uncertain: false,
      diagnostic: { phase: 'TRANSPORT', method: 'GET', httpStatus: null } });
    expect(write).toMatchObject({ retrySafe: false, uncertain: true,
      diagnostic: { phase: 'TRANSPORT', method: 'POST', httpStatus: null } });
    expect(JSON.stringify([read, write])).not.toContain(secret);
  });

  it('retains successful HTTP status when response decoding fails after a mutation', async () => {
    const error = await failure(client(async () => new Response(secret, { status: 201 })).createInbox(1, 'Synthetic', 'https://broker.example.test/events'));
    expect(error).toMatchObject({ code: 'CHATWOOT_INVALID_RESPONSE', retrySafe: false, uncertain: true,
      diagnostic: { phase: 'RESPONSE_BODY', method: 'POST', httpStatus: 201 } });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('bounds metadata even when an adapter constructs an error with untrusted extra fields', () => {
    // Runtime input must not turn the diagnostic projection into a remote-body log.
    const ErrorWithDiagnostics = ChatwootError as unknown as new (...args: unknown[]) => ChatwootError & { diagnostic: unknown };
    const error = new ErrorWithDiagnostics('CHATWOOT_UNAVAILABLE', true, false, 999,
      { phase: secret, method: secret, httpStatus: 999, token: secret, body: secret });
    expect(error.diagnostic).toEqual({ phase: 'UNKNOWN', method: null, httpStatus: null });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
