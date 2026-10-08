import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createS3PrivateObjectStore, privateObjectKey } from '../../src/modules/messaging/private-object-store.js';

const instant = new Date('2026-10-08T09:00:00-03:00');
const ref = Object.freeze({
  organizationId: '11111111-1111-4111-8111-111111111111',
  channelId: '22222222-2222-4222-8222-222222222222',
  mediaId: '33333333-3333-4333-8333-333333333333',
  operationId: '44444444-4444-4444-8444-444444444444',
});
const key = 'private-v1/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444.cipher';
const bytes = new Uint8Array(Buffer.from('hello'));
const expected = { byteLength: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' };
const control = () => ({ deadline: new Date(instant.getTime() + 30_000) });
const defaults = {
  endpoint: 'https://objects.example.test', bucket: 'broker-private', profile: 'private-v1',
  region: 'us-east-1', accessKeyId: 'SYNTHETICACCESS', secretAccessKey: 'synthetic-unit-secret',
  dedicatedBucket: true as const, clock: () => new Date(instant),
};
const xmlError = (code: string) => `<Error><Code>${code}</Code><Message>private upstream detail</Message><Resource>/private-bucket</Resource><RequestId>synthetic</RequestId></Error>`;
function fakeStore(object: (url: URL, init: RequestInit) => Promise<Response> | Response,
  preflight?: (query: string) => Response) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.search) {
      if (preflight) return preflight(url.search);
      if (url.search === '?versioning=') return new Response('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>');
      if (url.search === '?object-lock=') return new Response(xmlError('ObjectLockConfigurationNotFoundError'), { status: 404 });
      if (url.search === '?policy=') return new Response(xmlError('NoSuchBucketPolicy'), { status: 404 });
      if (url.search === '?acl=') return new Response('<AccessControlPolicy><Owner><ID>synthetic-owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>synthetic-owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>');
      throw new Error('unexpected subresource');
    }
    return object(url, init);
  };
  return { fetch, requests, store: createS3PrivateObjectStore({ ...defaults, fetch }) };
}

it('rejects an insecure non-loopback endpoint before credentials can leave the process', async () => {
  const factory = await import('../../src/modules/messaging/private-object-store.js')
    .then(module => module.createS3PrivateObjectStore).catch(() => undefined);
  expect(() => factory?.({
    endpoint: 'http://objects.example.test', bucket: 'broker-private', profile: 'private-v1',
    region: 'us-east-1', accessKeyId: 'SYNTHETICACCESS', secretAccessKey: 'synthetic-unit-secret',
    dedicatedBucket: true,
  })).toThrow('OBJECT_INVALID_CONFIG');
});

it.each([
  { endpoint: 'https://user:pass@objects.example.test' },
  { endpoint: 'https://objects.example.test/path' },
  { endpoint: 'https://objects.example.test/?token=secret' },
  { endpoint: 'https://objects.example.test/#fragment' },
  { endpoint: 'http://objects.example.test', allowLoopbackHttpForTests: true },
  { bucket: '../public' }, { profile: '../private' }, { region: 'x\r\nAuthorization: secret' },
  { accessKeyId: 'key\nsecret' }, { secretAccessKey: '' }, { dedicatedBucket: false },
])('rejects unsafe configuration without exposing input %#', patch => {
  expect(() => createS3PrivateObjectStore({ ...defaults, ...patch })).toThrow('OBJECT_INVALID_CONFIG');
});

it('permits HTTP only for explicitly enabled loopback tests', () => {
  expect(() => createS3PrivateObjectStore({ ...defaults, endpoint: 'http://127.0.0.1:9000', allowLoopbackHttpForTests: true })).not.toThrow();
  expect(() => createS3PrivateObjectStore({ ...defaults, endpoint: 'http://127.0.0.1:9000' })).toThrow('OBJECT_INVALID_CONFIG');
});

it('derives a tenant/channel/media/operation key and rejects paths or unknown ref fields', () => {
  expect(privateObjectKey('private-v1', ref)).toBe(key);
  expect(() => privateObjectKey('private-v1', { ...ref, mediaId: '../foreign' })).toThrow('OBJECT_INVALID_REF');
  const unexpectedRef = { ...ref, objectKey: 'foreign/key' };
  expect(() => privateObjectKey('private-v1', unexpectedRef)).toThrow('OBJECT_INVALID_REF');
  expect(privateObjectKey('private-v1', { ...ref, organizationId: '55555555-5555-4555-8555-555555555555' })).not.toBe(key);
});

it('signs a single immutable PUT with UTC clock and preserves the exact ciphertext', async () => {
  const h = fakeStore(() => new Response(null, { status: 200 }));
  expect(await h.store.put(ref, bytes, expected, control())).toEqual({ outcome: 'CONFIRMED' });
  const upload = h.requests.find(r => r.init.method === 'PUT')!;
  expect(upload.url.href).toBe(`https://objects.example.test/broker-private/${key}`);
  const headers = new Headers(upload.init.headers);
  expect(headers.get('if-none-match')).toBe('*');
  expect(headers.get('x-amz-date')).toBe('20261008T120000Z');
  expect(headers.get('x-amz-content-sha256')).toBe(expected.sha256);
  expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=SYNTHETICACCESS\/20261008\/us-east-1\/s3\/aws4_request, SignedHeaders=/);
  expect(upload.init.redirect).toBe('error');
  expect(Buffer.from(upload.init.body as Uint8Array)).toEqual(Buffer.from(bytes));
  expect(h.requests.filter(r => r.init.method === 'PUT')).toHaveLength(1);
  // Fixed SigV4 fixture, calculated from the documented canonical request independently of the adapter.
  expect(new Headers(h.requests[0]!.init.headers).get('authorization')).toBe(
    'AWS4-HMAC-SHA256 Credential=SYNTHETICACCESS/20261008/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=5ba55b8769f48018ae87f5fbf88a0ee3709fd483e4ad4ea1ccf2840a181cdae5');
});

it.each(['Enabled', 'Suspended'])('rejects %s versioning before any upload', async status => {
  const h = fakeStore(() => new Response(null, { status: 200 }), () => new Response(`<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>`));
  expect(await h.store.put(ref, bytes, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_BUCKET_UNSAFE' });
  expect(h.requests.every(r => r.init.method === 'GET')).toBe(true);
});

it.each([
  [200, '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>'],
  [403, xmlError('AccessDenied')], [404, xmlError('NoSuchBucket')], [501, xmlError('NotImplemented')],
  [404, '<Error><Code>ObjectLockConfigurationNotFoundError</Code><Code>NoSuchBucket</Code></Error>'],
])('never assumes Object Lock is absent from response %#', async (status, body) => {
  const h = fakeStore(() => new Response(null, { status: 200 }), query => query === '?versioning='
    ? new Response('<VersioningConfiguration/>') : new Response(String(body), { status: Number(status) }));
  expect((await h.store.put(ref, bytes, expected, control())).outcome).toBe('REJECTED');
  expect(h.requests.some(r => r.init.method === 'PUT')).toBe(false);
});

it('rejects an anonymous bucket policy before sending ciphertext', async () => {
  const h = fakeStore(() => new Response(null, { status: 200 }), query => query === '?versioning='
    ? new Response('<VersioningConfiguration/>') : query === '?object-lock='
      ? new Response(xmlError('ObjectLockConfigurationNotFoundError'), { status: 404 })
      : Response.json({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }] }));
  expect(await h.store.put(ref, bytes, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_BUCKET_UNSAFE' });
  expect(h.requests.some(r => r.init.method === 'PUT')).toBe(false);
});

it('keeps a dispatched PUT uncertain on network failure and never retries or exposes provider details', async () => {
  const h = fakeStore(() => { throw new Error('https://private/secret?credential=secret'); });
  const result = await h.store.put(ref, bytes, expected, control());
  expect(result).toEqual({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  expect(h.requests.filter(r => r.init.method === 'PUT')).toHaveLength(1);
  expect(JSON.stringify(result)).not.toMatch(/credential|https|private\/secret/);
});

it('reports an immutable-key conflict without overwriting or retrying', async () => {
  const h = fakeStore(() => new Response(xmlError('PreconditionFailed'), { status: 412 }));
  expect(await h.store.put(ref, bytes, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_CONFLICT' });
  expect(h.requests.filter(r => r.init.method === 'PUT')).toHaveLength(1);
});

it.each([500, 503, 307])('leaves HTTP %s mutation responses UNKNOWN', async status => {
  const h = fakeStore(() => new Response('private upstream detail', { status }));
  expect((await h.store.put(ref, bytes, expected, control())).outcome).toBe('UNKNOWN');
  expect(h.requests.filter(r => r.init.method === 'PUT')).toHaveLength(1);
});

it('does not confirm a PUT which unexpectedly created an object version', async () => {
  const h = fakeStore(() => new Response(null, { headers: { 'x-amz-version-id': 'unexpected-version' } }));
  expect(await h.store.put(ref, bytes, expected, control())).toEqual({ outcome: 'UNKNOWN', code: 'OBJECT_BUCKET_UNSAFE' });
});

it('reads verified ciphertext and inspect verifies bytes rather than trusting ETag or object metadata', async () => {
  const h = fakeStore(() => new Response(bytes, { headers: { ETag: 'misleading', 'x-amz-meta-sha256': 'untrusted' } }));
  expect(await h.store.read(ref, expected, control())).toEqual({ outcome: 'CONFIRMED', bytes });
  expect(await h.store.inspect(ref, expected, control())).toEqual({ outcome: 'CONFIRMED', byteLength: 5, sha256: expected.sha256 });
});

it.each([403, 404, 500])('does not call HTTP %s an absent object without NoSuchKey proof', async status => {
  const h = fakeStore(() => new Response(xmlError(status === 404 ? 'NoSuchBucket' : 'AccessDenied'), { status }));
  expect((await h.store.inspect(ref, expected, control())).outcome).not.toBe('MISSING');
});

it('accepts only explicit NoSuchKey as MISSING', async () => {
  const h = fakeStore(() => new Response(xmlError('NoSuchKey'), { status: 404 }));
  expect(await h.store.read(ref, expected, control())).toEqual({ outcome: 'MISSING' });
});

it('rejects tampered bytes even if metadata contains the expected hash', async () => {
  const h = fakeStore(() => new Response('jello', { headers: { 'x-amz-meta-sha256': expected.sha256 } }));
  expect(await h.store.read(ref, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_INTEGRITY_FAILED' });
});

it('bounds cumulative streamed bytes without Content-Length and cancels excess content', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5, 6])); },
    cancel() { canceled = true; },
  });
  const h = fakeStore(() => new Response(body));
  expect(await h.store.read(ref, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_LIMIT_EXCEEDED' });
  expect(canceled).toBe(true);
});

it('cancels a declared oversized response before reading its body', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
  const h = fakeStore(() => new Response(body, { headers: { 'Content-Length': '6' } }));
  expect(await h.store.read(ref, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_LIMIT_EXCEEDED' });
  expect(canceled).toBe(true);
});

it('rejects invalid ciphertext size/hash before any request', async () => {
  const h = fakeStore(() => new Response(null));
  expect((await h.store.put(ref, bytes, { ...expected, sha256: '0'.repeat(64) }, control())).outcome).toBe('REJECTED');
  expect((await h.store.put(ref, bytes, { ...expected, byteLength: 0 }, control())).outcome).toBe('REJECTED');
  expect((await h.store.read(ref, { byteLength: 40 * 1024 * 1024, sha256: expected.sha256 }, control())).outcome).toBe('REJECTED');
  expect(h.requests).toHaveLength(0);
});

it('does not dispatch expired or already aborted mutations', async () => {
  const h = fakeStore(() => new Response(null)); const abort = new AbortController(); abort.abort();
  expect(await h.store.put(ref, bytes, expected, { deadline: instant })).toEqual({ outcome: 'REJECTED', code: 'OBJECT_DEADLINE_EXCEEDED' });
  expect(await h.store.remove(ref, { ...control(), signal: abort.signal })).toEqual({ outcome: 'REJECTED', code: 'OBJECT_ABORTED' });
  expect(h.requests).toHaveLength(0);
});

it('aborts a stalled stream at deadline, cancels the body and returns only a static code', async () => {
  let canceled = false;
  const h = fakeStore(() => new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })));
  const result = await h.store.read(ref, expected, { deadline: new Date(instant.getTime() + 30) });
  expect(result).toEqual({ outcome: 'UNKNOWN', code: 'OBJECT_DEADLINE_EXCEEDED' });
  expect(canceled).toBe(true);
});

it('confirms DELETE only for an unversioned bucket and never repeats an uncertain DELETE', async () => {
  const h = fakeStore((_url, init) => init.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response(bytes));
  expect(await h.store.remove(ref, control())).toEqual({ outcome: 'CONFIRMED' });
  const bad = fakeStore(() => { throw new Error('private delete detail'); });
  expect(await bad.store.remove(ref, control())).toEqual({ outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' });
  expect(bad.requests.filter(r => r.init.method === 'DELETE')).toHaveLength(1);
});

it('does not confuse a delete marker with physical removal', async () => {
  const h = fakeStore(() => new Response(null, { status: 204, headers: { 'x-amz-delete-marker': 'true' } }));
  expect(await h.store.remove(ref, control())).toEqual({ outcome: 'UNKNOWN', code: 'OBJECT_BUCKET_UNSAFE' });
});

it('snapshots caller refs and ciphertext before the first asynchronous boundary', async () => {
  const mutableRef = { ...ref, organizationId: String(ref.organizationId) }; const mutableBytes = new Uint8Array(bytes);
  const h = fakeStore(() => new Response(null));
  const pending = h.store.put(mutableRef, mutableBytes, expected, control());
  mutableRef.organizationId = '55555555-5555-4555-8555-555555555555'; mutableBytes.fill(0);
  expect(await pending).toEqual({ outcome: 'CONFIRMED' });
  const upload = h.requests.find(r => r.init.method === 'PUT')!;
  expect(upload.url.pathname).toBe(`/broker-private/${key}`);
  expect(createHash('sha256').update(upload.init.body as Uint8Array).digest('hex')).toBe(expected.sha256);
});

it('rechecks the injected absolute deadline after preflight before dispatching a mutation', async () => {
  let now = new Date(instant);
  const h = fakeStore(() => new Response(null), query => {
    if (query === '?versioning=') return new Response('<VersioningConfiguration/>');
    if (query === '?object-lock=') return new Response(xmlError('ObjectLockConfigurationNotFoundError'), { status: 404 });
    now = new Date(instant.getTime() + 30_001);
    return new Response(xmlError('NoSuchBucketPolicy'), { status: 404 });
  });
  const store = createS3PrivateObjectStore({ ...defaults, fetch: h.fetch, clock: () => now });
  expect(await store.put(ref, bytes, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_DEADLINE_EXCEEDED' });
  expect(h.requests.some(request => request.init.method === 'PUT')).toBe(false);
});

it('does not wait without bound for cancellation after a confirmed mutation response', async () => {
  const h = fakeStore(() => new Response(new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) })));
  const result = await Promise.race([
    h.store.put(ref, bytes, expected, { deadline: new Date(instant.getTime() + 30) }),
    new Promise(resolve => setTimeout(() => resolve({ outcome: 'STALLED' }), 100)),
  ]);
  expect(result).toEqual({ outcome: 'CONFIRMED' });
});

it('cancels a rejected preflight response without dispatching object I/O', async () => {
  let canceled = false;
  const h = fakeStore(() => new Response(null), query => query === '?versioning='
    ? new Response('<VersioningConfiguration/>')
    : new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }), { status: 403 }));
  expect(await h.store.put(ref, bytes, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_PREFLIGHT_UNVERIFIED' });
  expect(canceled).toBe(true);
});

it('returns UNKNOWN when a dispatched PUT stalls and aborts its request signal once', async () => {
  const h = fakeStore(() => new Promise<Response>(() => {}));
  expect(await h.store.put(ref, bytes, expected, { deadline: new Date(instant.getTime() + 30) }))
    .toEqual({ outcome: 'UNKNOWN', code: 'OBJECT_DEADLINE_EXCEEDED' });
  const sent = h.requests.filter(request => request.init.method === 'PUT');
  expect(sent).toHaveLength(1); expect(sent[0]!.init.signal?.aborted).toBe(true);
});

it.each(['http://acs.amazonaws.com/groups/global/AllUsers', 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'])('rejects the public ACL group %s even without a bucket policy', async uri => {
  const h = fakeStore(() => new Response(null));
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => new URL(String(input)).search === '?acl='
    ? new Response(`<AccessControlPolicy><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>${uri}</URI></Grantee><Permission>READ</Permission></Grant></AccessControlList></AccessControlPolicy>`)
    : h.fetch(input, init);
  const store = createS3PrivateObjectStore({ ...defaults, fetch });
  expect(await store.put(ref, bytes, expected, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_BUCKET_UNSAFE' });
  expect(h.requests.some(request => request.init.method === 'PUT')).toBe(false);
});

it('fails closed when bucket ACL privacy cannot be read', async () => {
  const h = fakeStore(() => new Response(null));
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => new URL(String(input)).search === '?acl='
    ? new Response(xmlError('AccessDenied'), { status: 403 }) : h.fetch(input, init);
  const store = createS3PrivateObjectStore({ ...defaults, fetch });
  expect(await store.remove(ref, control())).toEqual({ outcome: 'REJECTED', code: 'OBJECT_PREFLIGHT_UNVERIFIED' });
  expect(h.requests.some(request => request.init.method === 'DELETE')).toBe(false);
});

it('uses native fetch against a loopback S3 protocol endpoint with no cloud credentials', async () => {
  let stored: Buffer | undefined; const requests: { method: string; path: string; date: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ method: request.method!, path: url.pathname, date: request.headers['x-amz-date'] as string | undefined, authorization: request.headers.authorization });
    if (url.searchParams.has('versioning')) return reply.end('<VersioningConfiguration/>');
    if (url.searchParams.has('object-lock')) { reply.statusCode = 404; return reply.end(xmlError('ObjectLockConfigurationNotFoundError')); }
    if (url.searchParams.has('policy')) { reply.statusCode = 404; return reply.end(xmlError('NoSuchBucketPolicy')); }
    if (url.searchParams.has('acl')) return reply.end('<AccessControlPolicy><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><Type>CanonicalUser</Type></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>');
    if (request.method === 'PUT') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      stored = Buffer.concat(chunks); return reply.end();
    }
    if (request.method === 'GET') { reply.write(stored!.subarray(0, 2)); return reply.end(stored!.subarray(2)); }
    stored = undefined; reply.statusCode = 204; return reply.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test listener');
    const store = createS3PrivateObjectStore({ ...defaults, endpoint: `http://127.0.0.1:${address.port}`, allowLoopbackHttpForTests: true });
    expect(await store.put(ref, bytes, expected, control())).toEqual({ outcome: 'CONFIRMED' });
    expect(stored).toEqual(Buffer.from(bytes));
    expect(await store.read(ref, expected, control())).toEqual({ outcome: 'CONFIRMED', bytes });
    expect(await store.remove(ref, control())).toEqual({ outcome: 'CONFIRMED' });
    expect(stored).toBeUndefined();
    expect(requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    expect(requests.every(request => request.date === '20261008T120000Z' && request.authorization?.startsWith('AWS4-HMAC-SHA256 '))).toBe(true);
    expect(requests.filter(request => request.method === 'PUT' || request.method === 'DELETE').map(request => request.path)).toEqual([`/broker-private/${key}`, `/broker-private/${key}`]);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
