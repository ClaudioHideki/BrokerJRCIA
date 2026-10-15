import { ApiClientError, type ApiClient } from '../api/client.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type NativeEditorOptions = {
  accountId: number; handleId: string; integrationIds: string[]; rootAutomationId?: string;
  request(method: string, path: string, body: unknown, signal?: AbortSignal,
    idempotencyKey?: string, mediaHeaders?: Record<string, string>): Promise<unknown>;
};
function invalid(): never { throw new Error('FLOW_INVALID_REQUEST'); }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const checkAbort = (signal?: AbortSignal | null) => { if (signal?.aborted) throw new DOMException('Consulta cancelada.', 'AbortError'); };

/** An Account session BFF supplies authority. This adapter has no Broker token,
 * never infers the current root from a late response, and cannot call global APIs. */
export function createNativeEditorTransport(options: NativeEditorOptions): Pick<ApiClient, 'request'> {
  if (!Number.isSafeInteger(options.accountId) || options.accountId < 1 || !uuid.test(options.handleId) ||
      !options.integrationIds.length || options.integrationIds.some(id => !uuid.test(id)) ||
      options.rootAutomationId !== undefined && !uuid.test(options.rootAutomationId)) throw new Error('FLOW_INVALID_CONTEXT');
  const revisions = new Map<string, number>();
  const prefix = `/api/v1/accounts/${options.accountId}/jrc_flow_delegation/sessions/${options.handleId}/flows`;
  const root = options.rootAutomationId;
  const assertRoot = (id: string) => { if (root && id !== root) throw new Error('FLOW_ROOT_MISMATCH'); };
  const call = async (method: string, path: string, body: unknown, signal?: AbortSignal | null, key?: string) => {
    checkAbort(signal);
    const raw = await options.request(method, prefix + path, body, signal ?? undefined, key);
    checkAbort(signal);
    if (record(raw) && 'scopeRevision' in raw) {
      const { scopeRevision, ...result } = raw;
      if (typeof result.id !== 'string' || !uuid.test(result.id) || !Number.isSafeInteger(scopeRevision) || Number(scopeRevision) < 1) {
        throw new ApiClientError('A central retornou uma revisão de fluxo inválida.', 502);
      }
      assertRoot(result.id); revisions.set(result.id, Number(scopeRevision)); return result;
    }
    return raw;
  };
  const request: ApiClient['request'] = async <T>(path: string, init: RequestInit = {}) => {
    checkAbort(init.signal);
    const uri = new URL(path, 'https://native.invalid'), method = (init.method ?? 'GET').toUpperCase();
    if (!path.startsWith('/v1/') || uri.origin !== 'https://native.invalid' || uri.hash ||
        path !== uri.pathname + uri.search) throw new Error('FLOW_UNSUPPORTED_OPERATION');
    const media = /^\/v1\/automations\/([^/]+)\/channels\/([^/]+)\/media$/.exec(uri.pathname);
    const binary = Boolean(media && method === 'POST');
    const headers = new Headers(init.headers);
    const allowed = binary ? ['content-type', 'idempotency-key', 'x-jrc-media-mime', 'x-jrc-media-kind', 'x-jrc-media-name'] : ['content-type', 'idempotency-key'];
    for (const key of headers.keys()) if (!allowed.includes(key)) invalid();
    const idempotency = headers.get('idempotency-key') ?? undefined;
    if (idempotency && !uuid.test(idempotency)) invalid();
    if (binary) {
      const id = media![1]!, channel = media![2]!, bytes = init.body;
      const size = bytes instanceof Blob ? bytes.size : bytes instanceof Uint8Array ? bytes.byteLength : 0;
      if (uri.search || !uuid.test(id) || !uuid.test(channel) || !size || size > 16 * 1024 * 1024 ||
          !idempotency || headers.get('content-type') !== 'application/octet-stream') invalid();
      assertRoot(id);
      const metadata: Record<string, string> = {};
      for (const key of ['x-jrc-media-mime', 'x-jrc-media-kind', 'x-jrc-media-name']) {
        const value = headers.get(key); if (!value) invalid(); metadata[key] = value;
      }
      const result = await options.request('post', `${prefix}/${id}/channels/${channel}/media`, bytes,
        init.signal ?? undefined, idempotency, metadata);
      checkAbort(init.signal); return result as T;
    }
    if (init.body !== undefined && typeof init.body !== 'string') invalid();
    let body: unknown;
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { invalid(); } if (!record(body)) invalid(); }
    const query = uri.searchParams;
    for (const key of query.keys()) if (!['cursor', 'pageSize'].includes(key) || query.getAll(key).length !== 1) invalid();
    const cursor = query.get('cursor'), size = query.get('pageSize');
    if (cursor !== null && !/^[A-Za-z0-9_-]{1,256}$/.test(cursor) || size !== null && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(size)) invalid();
    const suffix = cursor ? '?cursor=' + cursor : '';
    if (uri.pathname === '/v1/automation-nodes' && method === 'GET' && !uri.search) return await call('get', '/nodes', undefined, init.signal) as T;
    if (uri.pathname === '/v1/automations/status' && method === 'GET' && !uri.search) return await call('get', '/status', undefined, init.signal) as T;
    if (uri.pathname === '/v1/automations') {
      if (method === 'GET' && body === undefined) return await call('get', suffix, undefined, init.signal) as T;
      if (method === 'POST' && !uri.search && record(body)) {
        if (Object.keys(body).some(key => !['name', 'graph'].includes(key))) invalid();
        return await call('post', '', { ...body, integrationIds: [...options.integrationIds] }, init.signal, idempotency) as T;
      }
    }
    if (uri.pathname === '/v1/automation-imports/preview' && method === 'POST' && !uri.search && record(body)) {
      return await call('post', '/import-preview', { ...body, integrationIds: [...options.integrationIds] }, init.signal) as T;
    }
    if (method === 'GET' && !uri.search && root) {
      if (uri.pathname === '/v1/integrations/chatwoot') return await call('get', `/${root}/handoff-connections`, undefined, init.signal) as T;
      if (uri.pathname === '/v1/attendance/local-channels') return await call('get', `/${root}/local-handoff-channels`, undefined, init.signal) as T;
      const central = /^\/v1\/integrations\/chatwoot\/connections\/([^/]+)\/attendance-catalog$/.exec(uri.pathname);
      if (central && uuid.test(central[1]!)) return await call('get', `/${root}/integrations/${central[1]}/attendance-catalog`, undefined, init.signal) as T;
      const local = /^\/v1\/attendance\/local-channels\/([^/]+)\/catalog$/.exec(uri.pathname);
      if (local && uuid.test(local[1]!)) return await call('get', `/${root}/channels/${local[1]}/local-attendance-catalog`, undefined, init.signal) as T;
    }
    const resource = /^\/v1\/automations\/([^/]+)\/(resource-channels|channels\/([^/]+)\/(action-catalog|action-resources|media)(?:\/([^/]+)\/(revoke))?)$/.exec(uri.pathname);
    if (resource) {
      const [, id, tail, channel, action, asset, revoke] = resource;
      if (!id || !uuid.test(id) || channel && !uuid.test(channel) || asset && !uuid.test(asset)) invalid();
      if (asset && action !== 'media') invalid();
      assertRoot(id);
      const paginated = tail === 'resource-channels' || action === 'action-catalog';
      if (method === 'GET' && (paginated || action === 'media' && !asset) && body === undefined) {
        if (!paginated && uri.search) invalid();
        return await call('get', `/${id}/${tail}${suffix}`, undefined, init.signal) as T;
      }
      if (method === 'POST' && !uri.search && record(body) && (action === 'action-resources' && !asset || revoke === 'revoke')) {
        return await call('post', `/${id}/${tail}`, body, init.signal, idempotency) as T;
      }
      invalid();
    }
    const match = /^\/v1\/automations\/([^/]+)(?:\/(http-credentials|subflow-catalog|ai-credentials|validate|simulate|publish|versions))?$/.exec(uri.pathname);
    if (!match || !uuid.test(match[1]!)) throw new Error('FLOW_UNSUPPORTED_OPERATION');
    const id = match[1]!, operation = match[2]; assertRoot(id);
    const page = ['http-credentials', 'subflow-catalog', 'ai-credentials', 'versions'].includes(operation ?? '');
    if (!operation && ['GET', 'PUT'].includes(method) || operation && page && method === 'GET' ||
        operation && ['validate', 'simulate', 'publish'].includes(operation) && method === 'POST') {
      if (uri.search && !page || method === 'GET' && body !== undefined) invalid();
      if (method === 'PUT' || operation === 'publish') {
        if (!revisions.has(id)) {
          const scope = await call('get', `/${id}/scope`, undefined, init.signal);
          if (!record(scope) || !Number.isSafeInteger(scope.revision) || Number(scope.revision) < 1) invalid();
          revisions.set(id, Number(scope.revision));
        }
        body = { ...(record(body) ? body : {}), expectedScopeRevision: revisions.get(id) };
      }
      return await call(method.toLowerCase(), `/${id}${operation ? '/' + operation : ''}${suffix}`, body, init.signal) as T;
    }
    throw new Error('FLOW_UNSUPPORTED_OPERATION');
  };
  return { request };
}
