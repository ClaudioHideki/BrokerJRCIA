import { describe, expect, it } from 'vitest';
import { EvolutionWorkspaceClient, type ProviderContext } from '../src/index.js';

const settings = { rejectCall: false, msgCall: '', groupsIgnore: true, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false };
const context: ProviderContext = { organizationId: 'org-test', requestId: 'request-test', deadline: new Date('2030-01-01'), signal: new AbortController().signal };
function setup(bodies: unknown[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new EvolutionWorkspaceClient({ baseUrl: 'http://engine.test', apiKey: 'secret-api', fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    const body = bodies.shift();
    return body instanceof Response ? body : new Response(JSON.stringify(body));
  } });
  return { client, calls };
}
describe('Evolution workspace', () => {
  it('maps only the exact instance and exposes a restricted snapshot', async () => {
    const { client, calls } = setup([[{ name: 'other' }, { name: 'key /&', profileName: 'Test profile', ownerJid: '123456789@s.whatsapp.net', connectionStatus: 'open', token: 'secret-token', proxy: { password: 'secret-proxy' }, Setting: { ...settings, wavoipToken: 'secret-voice' }, _count: { Contact: 0, Chat: 3, Message: 12 } }]]);
    expect(await client.read(context, 'key /&')).toEqual({ profile: { name: 'Test profile', phone: '123456789', state: 'open' }, counts: { contacts: 0, chats: 3, messages: 12 }, settings });
    expect(calls[0]?.url).toBe('http://engine.test/instance/fetchInstances?instanceName=key%20%2F%26');
  });
  it.each([[{ name: 'other' }], [], [{ name: 'key' }, { name: 'key' }], { error: 'secret' }].map((body) => [body]))('rejects absent or ambiguous mapping', async (body) => {
    const { client } = setup([body]);
    await expect(client.read(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });
  it('keeps invalid counts, missing fields and non-phone JIDs unknown', async () => {
    const { client } = setup([[{ name: 'key', ownerJid: '123456789@lid', _count: { Contact: -1, Chat: '3', Message: 1.2 }, Setting: null }], null]);
    expect(await client.read(context, 'key')).toEqual({ profile: { name: null, phone: null, state: null }, counts: { contacts: null, chats: null, messages: null }, settings: null });
  });
  it('reads settings from the dedicated endpoint when absent', async () => {
    const { client, calls } = setup([[{ name: 'key' }], { ...settings, token: 'secret' }]);
    expect((await client.read(context, 'key')).settings).toEqual(settings);
    expect(calls[1]?.url).toBe('http://engine.test/settings/find/key');
  });
  it('redacts an upstream error response', async () => {
    const { client } = setup([new Response('secret-body', { status: 500 })]);
    await expect(client.read(context, 'key')).rejects.toThrow('PROVIDER_REQUEST_FAILED');
  });
  it('rejects oversized streamed responses without content length', async () => {
    const { client } = setup([new Response(' '.repeat(1_048_577))]);
    await expect(client.read(context, 'key')).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });
  it('writes only seven allowed settings fields', async () => {
    const { client, calls } = setup([settings, { settings: { instanceName: 'key /&', settings } }]);
    await client.updateSettings(context, 'key /&', { ...settings, token: 'secret', wavoipToken: 'secret' } as typeof settings);
    expect(calls[1]?.url).toBe('http://engine.test/settings/set/key%20%2F%26');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(settings);
    expect(calls[1]?.init?.method).toBe('POST');
  });
  it('does not clear an existing voice integration in upstream memory', async () => {
    const { client, calls } = setup([{ ...settings, wavoipToken: 'secret-voice' }]);
    await expect(client.updateSettings(context, 'key', settings)).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
    expect(calls).toHaveLength(1);
  });
  it('cancels a stalled response stream at the caller deadline', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const { client } = setup([new Response(body)]);
    await expect(client.read({ ...context, deadline: new Date(Date.now() + 30) }, 'key')).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(cancelled).toBe(true);
  });
  it('does not request upstream when the caller has aborted', async () => {
    const { client, calls } = setup([]);
    await expect(client.read({ ...context, signal: AbortSignal.abort() }, 'key')).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
    expect(calls).toHaveLength(0);
  });
  it('does not send malformed settings upstream', async () => {
    const { client, calls } = setup([]);
    await expect(client.updateSettings(context, 'key', { ...settings, readStatus: 'false' } as unknown as typeof settings)).rejects.toMatchObject({ code: 'INVALID_PROVIDER_CONTEXT' });
    expect(calls).toHaveLength(0);
  });
  it('rejects an error envelope returned with HTTP success after update', async () => {
    const { client } = setup([settings, { error: 'secret-error-body' }]);
    await expect(client.updateSettings(context, 'key', settings)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });
});
