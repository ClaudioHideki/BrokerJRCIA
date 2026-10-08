import { createHash, createHmac } from 'node:crypto';
import { MAX_MEDIA_BYTES } from '@jrc/providers';

/** The unchanged v1 envelope encodes base64 plaintext and then base64url ciphertext. */
export const MAX_PRIVATE_OBJECT_BYTES = 4 * Math.ceil((4 * Math.ceil(MAX_MEDIA_BYTES / 3)) / 3) + 64;
const MAX_CONTROL_BYTES = 32 * 1024;
type ObjectCode = 'OBJECT_INVALID_CONFIG' | 'OBJECT_INVALID_REF' | 'OBJECT_INVALID_CIPHERTEXT'
  | 'OBJECT_DEADLINE_EXCEEDED' | 'OBJECT_ABORTED' | 'OBJECT_PREFLIGHT_UNVERIFIED'
  | 'OBJECT_BUCKET_UNSAFE' | 'OBJECT_REQUEST_UNVERIFIED' | 'OBJECT_ACCESS_DENIED'
  | 'OBJECT_CONFLICT' | 'OBJECT_MUTATION_REJECTED' | 'OBJECT_LIMIT_EXCEEDED' | 'OBJECT_INTEGRITY_FAILED';
export class PrivateObjectStoreError extends Error {
  constructor(readonly code: ObjectCode) { super(code); this.name = 'PrivateObjectStoreError'; }
}
export type PrivateObjectRef = Readonly<{
  organizationId: string; channelId: string; mediaId: string; operationId: string;
}>;
export type ObjectStoreControl = Readonly<{ deadline: Date; signal?: AbortSignal }>;
export type ExpectedCiphertext = Readonly<{ byteLength: number; sha256: string }>;
export type ObjectStoreFailure = Readonly<{ outcome: 'UNKNOWN' | 'REJECTED'; code: ObjectCode }>;
export type ObjectStoreMutation = Readonly<{ outcome: 'CONFIRMED' }> | ObjectStoreFailure;
export type ObjectStoreRead = Readonly<{ outcome: 'CONFIRMED'; bytes: Uint8Array }>
  | Readonly<{ outcome: 'MISSING' }> | ObjectStoreFailure;
export type ObjectStoreInspection = Readonly<{ outcome: 'CONFIRMED'; byteLength: number; sha256: string }>
  | Readonly<{ outcome: 'MISSING' }> | ObjectStoreFailure;
export interface PrivateObjectStore {
  put(ref: PrivateObjectRef, ciphertext: Uint8Array, expected: ExpectedCiphertext, control: ObjectStoreControl): Promise<ObjectStoreMutation>;
  read(ref: PrivateObjectRef, expected: ExpectedCiphertext, control: ObjectStoreControl): Promise<ObjectStoreRead>;
  inspect(ref: PrivateObjectRef, expected: ExpectedCiphertext, control: ObjectStoreControl): Promise<ObjectStoreInspection>;
  remove(ref: PrivateObjectRef, control: ObjectStoreControl): Promise<ObjectStoreMutation>;
}
export interface S3PrivateObjectStoreConfig {
  endpoint: string; bucket: string; profile: string; region: string;
  accessKeyId: string; secretAccessKey: string; dedicatedBucket: boolean;
  maxObjectBytes?: number; requestTimeoutMs?: number;
  allowLoopbackHttpForTests?: boolean; clock?: () => Date; fetch?: typeof fetch;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const profilePattern = /^[a-z][a-z0-9-]{0,63}$/;
const refFields = ['organizationId', 'channelId', 'mediaId', 'operationId'] as const;
function fail(code: ObjectCode): never { throw new PrivateObjectStoreError(code); }
function digest(bytes: Uint8Array | string) { return createHash('sha256').update(bytes).digest('hex'); }

/** No filename, caller object key, URL, or upstream identifier enters an object path. */
export function privateObjectKey(profile: string, ref: PrivateObjectRef): string {
  if (!profilePattern.test(profile) || !ref || typeof ref !== 'object'
    || Object.keys(ref).length !== refFields.length
    || !Object.keys(ref).every(field => (refFields as readonly string[]).includes(field))
    || !refFields.every(field => typeof ref[field] === 'string' && uuid.test(ref[field]))) fail('OBJECT_INVALID_REF');
  return `${profile}/${ref.organizationId}/${ref.channelId}/${ref.mediaId}/${ref.operationId}.cipher`;
}

type XmlNode = { name: string; children: XmlNode[]; text: string; attributes: Record<string, string> };
/** Small bounded XML subset for S3 control responses; DTDs/entities are never resolved. */
function parseControlXml(text: string): XmlNode {
  const source = text.trim().replace(/^<\?xml\s[^?]*\?>\s*/, '');
  if (source.includes('<!') || source.includes('&') || source.includes('<?')) fail('OBJECT_PREFLIGHT_UNVERIFIED');
  const stack: XmlNode[] = [], roots: XmlNode[] = [];
  const tokens = source.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== source || tokens.length > 256) fail('OBJECT_PREFLIGHT_UNVERIFIED');
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (!stack.length && token.trim()) fail('OBJECT_PREFLIGHT_UNVERIFIED');
      if (stack.length) stack[stack.length - 1]!.text += token;
      continue;
    }
    const closing = /^<\/([A-Za-z][\w:.-]*)\s*>$/.exec(token);
    if (closing) {
      if (stack.pop()?.name !== closing[1]) fail('OBJECT_PREFLIGHT_UNVERIFIED');
      continue;
    }
    const opening = /^<([A-Za-z][\w:.-]*)(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*(\/?)>$/.exec(token);
    if (!opening || stack.length > 8) fail('OBJECT_PREFLIGHT_UNVERIFIED');
    const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const attribute of token.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/g)) {
      if (Object.hasOwn(attributes, attribute[1]!)) fail('OBJECT_PREFLIGHT_UNVERIFIED');
      attributes[attribute[1]!] = attribute[2] ?? attribute[3]!;
    }
    const node: XmlNode = { name: opening[1]!, children: [], text: '', attributes };
    (stack.length ? stack[stack.length - 1]!.children : roots).push(node);
    if (!opening[2]) stack.push(node);
  }
  if (stack.length || roots.length !== 1) fail('OBJECT_PREFLIGHT_UNVERIFIED');
  return roots[0]!;
}
function errorCode(text: string): string | undefined {
  const root = parseControlXml(text);
  const code = root.children.filter(node => node.name === 'Code');
  return root.name === 'Error' && code.length === 1 && !code[0]!.children.length
    ? code[0]!.text.trim() : undefined;
}

type RequestScope = { signal: AbortSignal; check(): void; close(): void };
function requestScope(control: ObjectStoreControl, clock: () => Date, timeout: number): RequestScope {
  if (!(control?.deadline instanceof Date) || !Number.isFinite(control.deadline.getTime())) fail('OBJECT_DEADLINE_EXCEEDED');
  const deadline = control.deadline.getTime(), parent = control.signal;
  const duration = Math.min(deadline - clock().getTime(), timeout);
  if (duration <= 0) fail('OBJECT_DEADLINE_EXCEEDED');
  if (parent?.aborted) fail('OBJECT_ABORTED');
  const abort = new AbortController();
  const upstream = () => abort.abort(new PrivateObjectStoreError('OBJECT_ABORTED'));
  parent?.addEventListener('abort', upstream, { once: true });
  const timer = setTimeout(() => abort.abort(new PrivateObjectStoreError('OBJECT_DEADLINE_EXCEEDED')), duration);
  return { signal: abort.signal,
    check() {
      if (!abort.signal.aborted && clock().getTime() >= deadline) abort.abort(new PrivateObjectStoreError('OBJECT_DEADLINE_EXCEEDED'));
      if (abort.signal.aborted) throw abort.signal.reason;
    },
    close() { clearTimeout(timer); parent?.removeEventListener('abort', upstream); },
  };
}
async function withAbort<T>(work: Promise<T>, scope: RequestScope): Promise<T> {
  scope.check();
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(scope.signal.reason);
    scope.signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([work, stopped]); }
  finally { if (onAbort) scope.signal.removeEventListener('abort', onAbort); }
}
function cancel(response: Response) { void response.body?.cancel().catch(() => undefined); }
async function boundedBytes(response: Response, maximum: number, scope: RequestScope): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await cancel(response); fail('OBJECT_LIMIT_EXCEEDED');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('OBJECT_REQUEST_UNVERIFIED');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      scope.check();
      const part = await withAbort(reader.read(), scope);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) fail('OBJECT_LIMIT_EXCEEDED');
      chunks.push(part.value);
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}

/**
 * Narrow MinIO profile: path-style single-part requests, static credentials, no bucket policy,
 * never-versioned dedicated bucket, no Object Lock, and a private canonical-user ACL.
 * Bucket configuration is rechecked for each operation; no future configuration guarantee is implied.
 * Protocol sources (no vendor source copied):
 * https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketVersioning.html
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectLockConfiguration.html
 * https://github.com/minio/minio/blob/master/cmd/acl-handlers.go
 */
export function createS3PrivateObjectStore(config: S3PrivateObjectStoreConfig): PrivateObjectStore {
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { fail('OBJECT_INVALID_CONFIG'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  const maximum = config.maxObjectBytes ?? MAX_PRIVATE_OBJECT_BYTES;
  const timeout = config.requestTimeoutMs ?? 30_000;
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback && config.allowLoopbackHttpForTests === true))
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || config.bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(config.bucket)
    || !profilePattern.test(config.profile) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.region)
    || !/^[A-Za-z0-9_-]{3,128}$/.test(config.accessKeyId)
    || typeof config.secretAccessKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(config.secretAccessKey)
    || config.dedicatedBucket !== true || !Number.isInteger(maximum) || maximum < 1 || maximum > MAX_PRIVATE_OBJECT_BYTES
    || !Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) fail('OBJECT_INVALID_CONFIG');
  const bucket = config.bucket, profile = config.profile, region = config.region;
  const access = config.accessKeyId, secret = config.secretAccessKey;
  const transport = config.fetch ?? fetch, clock = config.clock ?? (() => new Date());
  function utcNow() {
    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.getUTCFullYear() < 1970 || now.getUTCFullYear() > 9999) fail('OBJECT_INVALID_CONFIG');
    return now;
  }
  function expectedCopy(expected: ExpectedCiphertext): ExpectedCiphertext {
    if (!expected || !Number.isInteger(expected.byteLength) || expected.byteLength < 1 || expected.byteLength > maximum
      || typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256)) fail('OBJECT_INVALID_CIPHERTEXT');
    return { byteLength: expected.byteLength, sha256: expected.sha256 };
  }
  function sign(method: string, url: URL, payload: Uint8Array, extra: Record<string, string>): Headers {
    const date = utcNow().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8), hash = digest(payload);
    const values: Record<string, string> = { host: url.host, 'x-amz-content-sha256': hash, 'x-amz-date': date, ...extra };
    const names = Object.keys(values).sort();
    const canonical = [method, url.pathname, url.search.slice(1), names.map(name => `${name}:${values[name]!.trim()}\n`).join(''), names.join(';'), hash].join('\n');
    const credentialScope = `${day}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, digest(canonical)].join('\n');
    const hmac = (key: string | Uint8Array, value: string) => createHmac('sha256', key).update(value).digest();
    const signing = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signing).update(stringToSign).digest('hex');
    return new Headers({ ...values, authorization: `AWS4-HMAC-SHA256 Credential=${access}/${credentialScope}, SignedHeaders=${names.join(';')}, Signature=${signature}` });
  }
  async function request(method: 'GET' | 'PUT' | 'DELETE', path: string, query: string | undefined,
    scope: RequestScope, payload = new Uint8Array(), onDispatch?: () => void): Promise<Response> {
    scope.check();
    const url = new URL(`/${bucket}${path}`, endpoint);
    if (query) url.search = `?${query}=`;
    const extra = method === 'PUT' ? { 'content-type': 'application/octet-stream', 'content-length': String(payload.byteLength), 'if-none-match': '*' } : {};
    const headers = sign(method, url, payload, extra);
    onDispatch?.();
    const response = await withAbort(transport(url, { method, headers, redirect: 'error', signal: scope.signal,
      ...(method === 'PUT' ? { body: payload } : {}),
    }), scope);
    return response;
  }
  async function controlText(response: Response, scope: RequestScope) {
    return new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(response, MAX_CONTROL_BYTES, scope));
  }
  async function preflight(scope: RequestScope) {
    try {
      const versioning = await request('GET', '', 'versioning', scope);
      if (versioning.status !== 200) { await cancel(versioning); fail('OBJECT_PREFLIGHT_UNVERIFIED'); }
      const version = parseControlXml(await controlText(versioning, scope));
      if (version.name !== 'VersioningConfiguration') fail('OBJECT_PREFLIGHT_UNVERIFIED');
      if (version.children.length || version.text.trim()) fail('OBJECT_BUCKET_UNSAFE');
      const lock = await request('GET', '', 'object-lock', scope);
      if (lock.status === 200) { await cancel(lock); fail('OBJECT_BUCKET_UNSAFE'); }
      if (lock.status !== 404) { cancel(lock); fail('OBJECT_PREFLIGHT_UNVERIFIED'); }
      if (errorCode(await controlText(lock, scope)) !== 'ObjectLockConfigurationNotFoundError') fail('OBJECT_PREFLIGHT_UNVERIFIED');
      const policy = await request('GET', '', 'policy', scope);
      if (policy.status === 200) { await cancel(policy); fail('OBJECT_BUCKET_UNSAFE'); }
      if (policy.status !== 404) { cancel(policy); fail('OBJECT_PREFLIGHT_UNVERIFIED'); }
      if (errorCode(await controlText(policy, scope)) !== 'NoSuchBucketPolicy') fail('OBJECT_PREFLIGHT_UNVERIFIED');
      // MinIO exposes a private compatibility ACL. Reading it also rejects public S3 ACLs.
      const acl = await request('GET', '', 'acl', scope);
      if (acl.status !== 200) { cancel(acl); fail('OBJECT_PREFLIGHT_UNVERIFIED'); }
      const root = parseControlXml(await controlText(acl, scope));
      const lists = root.children.filter(node => node.name === 'AccessControlList');
      if (root.name !== 'AccessControlPolicy' || lists.length !== 1) fail('OBJECT_PREFLIGHT_UNVERIFIED');
      const grants = lists[0]!.children;
      if (grants.length !== 1 || grants[0]!.name !== 'Grant') fail('OBJECT_BUCKET_UNSAFE');
      const grantees = grants[0]!.children.filter(node => node.name === 'Grantee');
      const permissions = grants[0]!.children.filter(node => node.name === 'Permission');
      if (grantees.length !== 1 || permissions.length !== 1 || permissions[0]!.children.length
        || permissions[0]!.text.trim() !== 'FULL_CONTROL') fail('OBJECT_BUCKET_UNSAFE');
      const grantee = grantees[0]!, types = grantee.children.filter(node => node.name === 'Type');
      const kind = grantee.attributes['xsi:type'] ?? (types.length === 1 ? types[0]!.text.trim() : undefined);
      if (kind !== 'CanonicalUser' || grantee.children.some(node => !['ID', 'DisplayName', 'Type'].includes(node.name))) fail('OBJECT_BUCKET_UNSAFE');
    } catch (error) {
      if (error instanceof PrivateObjectStoreError) throw error;
      fail('OBJECT_PREFLIGHT_UNVERIFIED');
    }
  }
  const errorResult = (error: unknown, dispatched: boolean): ObjectStoreFailure => ({
    outcome: dispatched && !(error instanceof PrivateObjectStoreError && ['OBJECT_INTEGRITY_FAILED', 'OBJECT_LIMIT_EXCEEDED'].includes(error.code)) ? 'UNKNOWN' : 'REJECTED',
    code: error instanceof PrivateObjectStoreError ? error.code : 'OBJECT_REQUEST_UNVERIFIED',
  });
  async function mutate(method: 'PUT' | 'DELETE', ref: PrivateObjectRef, control: ObjectStoreControl,
    ciphertext?: Uint8Array, expected?: ExpectedCiphertext): Promise<ObjectStoreMutation> {
    let scope: RequestScope | undefined, dispatched = false;
    try {
      const key = privateObjectKey(profile, ref);
      let body = new Uint8Array();
      if (method === 'PUT') {
        const valid = expectedCopy(expected!);
        if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength !== valid.byteLength) fail('OBJECT_INVALID_CIPHERTEXT');
        body = new Uint8Array(ciphertext);
        if (digest(body) !== valid.sha256) fail('OBJECT_INVALID_CIPHERTEXT');
      }
      scope = requestScope(control, utcNow, timeout);
      await preflight(scope);
      const response = await request(method, `/${key}`, undefined, scope, body, () => { dispatched = true; });
      await cancel(response);
      if (response.status === (method === 'PUT' ? 200 : 204)) {
        if ((response.headers.get('x-amz-version-id') && response.headers.get('x-amz-version-id') !== 'null')
          || response.headers.get('x-amz-delete-marker') === 'true') return { outcome: 'UNKNOWN', code: 'OBJECT_BUCKET_UNSAFE' };
        return { outcome: 'CONFIRMED' };
      }
      if (response.status === 412) return { outcome: 'REJECTED', code: 'OBJECT_CONFLICT' };
      if (response.status === 401 || response.status === 403) return { outcome: 'REJECTED', code: 'OBJECT_ACCESS_DENIED' };
      if (response.status === 400 || response.status === 404) return { outcome: 'REJECTED', code: 'OBJECT_MUTATION_REJECTED' };
      return { outcome: 'UNKNOWN', code: 'OBJECT_REQUEST_UNVERIFIED' };
    } catch (error) { return errorResult(error, dispatched); }
    finally { scope?.close(); }
  }
  async function read(ref: PrivateObjectRef, expected: ExpectedCiphertext, control: ObjectStoreControl): Promise<ObjectStoreRead> {
    let scope: RequestScope | undefined, dispatched = false;
    try {
      const key = privateObjectKey(profile, ref), valid = expectedCopy(expected);
      scope = requestScope(control, utcNow, timeout);
      await preflight(scope);
      const response = await request('GET', `/${key}`, undefined, scope, new Uint8Array(), () => { dispatched = true; });
      if (response.status === 404 && errorCode(await controlText(response, scope)) === 'NoSuchKey') return { outcome: 'MISSING' };
      if (response.status !== 200) {
        await cancel(response);
        return { outcome: 'UNKNOWN', code: response.status === 403 ? 'OBJECT_ACCESS_DENIED' : 'OBJECT_REQUEST_UNVERIFIED' };
      }
      const body = await boundedBytes(response, valid.byteLength, scope);
      if (body.byteLength !== valid.byteLength || digest(body) !== valid.sha256) fail('OBJECT_INTEGRITY_FAILED');
      return { outcome: 'CONFIRMED', bytes: body };
    } catch (error) { return errorResult(error, dispatched); }
    finally { scope?.close(); }
  }
  return Object.freeze({
    put: (ref: PrivateObjectRef, bytes: Uint8Array, expected: ExpectedCiphertext, control: ObjectStoreControl) => mutate('PUT', ref, control, bytes, expected),
    read,
    async inspect(ref: PrivateObjectRef, expected: ExpectedCiphertext, control: ObjectStoreControl): Promise<ObjectStoreInspection> {
      const result = await read(ref, expected, control);
      return result.outcome === 'CONFIRMED' ? { outcome: 'CONFIRMED', byteLength: result.bytes.byteLength, sha256: digest(result.bytes) } : result;
    },
    remove: (ref: PrivateObjectRef, control: ObjectStoreControl) => mutate('DELETE', ref, control),
  });
}
