import { describe, expect, it, vi } from 'vitest';
import { assertPublicAddresses, createChatwootSafeFetch } from '../../src/modules/integrations/chatwoot-safe-http.js';

describe('Chatwoot outbound network boundary', () => {
  it.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '172.31.1.1', '169.254.169.254', '192.168.1.1',
    '192.0.2.1', '198.19.1.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '0.0.0.0',
    '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::7f00:1',
    '2001:db8::1', '2002:7f00:1::1', '3fff::1', 'ff02::1', 'not-an-address'])('rejects %s', ip => {
    expect(() => assertPublicAddresses([ip])).toThrow('CHATWOOT_UNSAFE_ADDRESS');
  });
  it('requires a nonempty entirely public DNS answer', () => {
    expect(() => assertPublicAddresses([])).toThrow();
    expect(() => assertPublicAddresses(['8.8.8.8', '10.0.0.1'])).toThrow();
    expect(() => assertPublicAddresses(['8.8.8.8', '2606:4700:4700::1111'])).not.toThrow();
  });
  it('pins the approved answers and resolves again on the next request', async () => {
    const resolve = vi.fn().mockResolvedValueOnce(['8.8.8.8']).mockResolvedValueOnce(['127.0.0.1']);
    const connect = vi.fn().mockResolvedValue(new Response('{}'));
    const fetch = createChatwootSafeFetch({ origin: 'https://support.example.com', resolve, connect });
    await fetch('https://support.example.com/api/v1/profile', { headers: { api_access_token: 'synthetic' } });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      approvedAddresses: ['8.8.8.8'], servername: 'support.example.com', rejectUnauthorized: true,
    }));
    await expect(fetch('https://support.example.com/api/v1/profile')).rejects.toThrow('CHATWOOT_UNSAFE_ADDRESS');
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('blocks mixed answers before the token leaves the process', async () => {
    const connect = vi.fn();
    const fetch = createChatwootSafeFetch({ origin: 'https://support.example.com', resolve: async () => ['8.8.8.8', '::1'], connect });
    await expect(fetch('https://support.example.com', { headers: { api_access_token: 'synthetic' } })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([301, 302])('never follows an authenticated redirect (%s)', async status => {
    const connect = vi.fn().mockResolvedValue(new Response(null, { status, headers: { location: 'https://evil.example.com' } }));
    const fetch = createChatwootSafeFetch({ origin: 'https://support.example.com', resolve: async () => ['8.8.8.8'], connect });
    await expect(fetch('https://support.example.com/api', { headers: { api_access_token: 'synthetic' }, redirect: 'error' })).rejects.toThrow('CHATWOOT_REDIRECT_REJECTED');
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('allows approved media only without an API token and preserves multipart encoding', async () => {
    const connect = vi.fn().mockImplementation(async () => new Response('{}'));
    const fetch = createChatwootSafeFetch({ origin: 'https://support.example.com', mediaOrigins: ['https://cdn.example.com'], resolve: async () => ['8.8.8.8'], connect });
    await expect(fetch('https://other.example.com/media')).rejects.toThrow();
    await expect(fetch('https://cdn.example.com/media', { headers: { api_access_token: 'synthetic' } })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    await fetch('https://cdn.example.com/media');
    const form = new FormData();
    form.append('attachments[]', new Blob(['synthetic-file']), 'fixture.txt');
    await fetch('https://support.example.com/api', { method: 'POST', body: form });
    const args = connect.mock.calls[1]![0];
    expect(args.headers['content-type']).toContain('multipart/form-data; boundary=');
    expect(Buffer.from(args.body).toString()).toContain('synthetic-file');
  });
  it('honors cancellation while DNS is pending', async () => {
    const connect = vi.fn();
    const fetch = createChatwootSafeFetch({ origin: 'https://support.example.com', resolve: () => new Promise(() => {}), connect });
    await expect(fetch('https://support.example.com/api', { signal: AbortSignal.timeout(25) })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
