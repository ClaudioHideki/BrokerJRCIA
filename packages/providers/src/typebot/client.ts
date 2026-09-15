import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export type TypebotFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TypebotResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface TypebotPinnedRequest {
  address: string;
  body?: Uint8Array;
  family: 4 | 6;
  headers: Headers;
  hostHeader: string;
  method: string;
  servername: string;
  signal: AbortSignal;
  url: URL;
}

export type TypebotHostLookup = (
  hostname: string,
) => Promise<readonly TypebotResolvedAddress[]>;

export type TypebotPinnedDispatch = (
  request: TypebotPinnedRequest,
) => Promise<Response>;

export interface TypebotPinnedFetchOptions {
  /** Injectable only for deterministic transport tests. */
  dispatch?: TypebotPinnedDispatch;
  /** Injectable only for deterministic transport tests. */
  lookup?: TypebotHostLookup;
}

export type TypebotClientErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_ARGUMENT'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'SESSION_EXPIRED'
  | 'UNKNOWN'
  | 'UPSTREAM_ERROR';

export class TypebotClientError extends Error {
  readonly code: TypebotClientErrorCode;

  constructor(code: TypebotClientErrorCode) {
    super(code);
    this.name = 'TypebotClientError';
    this.code = code;
  }
}

export interface TypebotInputInfo {
  id: string;
  type: string;
}

export type TypebotIncompatibility =
  | { kind: 'UNSUPPORTED_MESSAGE'; id: string; type: string }
  | { kind: 'UNSUPPORTED_INPUT'; id: string; type: string }
  | { kind: 'CLIENT_SIDE_ACTION'; type: string };

export interface TypebotChatResult {
  sessionId: string;
  texts: string[];
  input?: TypebotInputInfo;
  incompatibilities: TypebotIncompatibility[];
}

export interface TypebotClientOptions {
  /** Server-controlled chat API origin. Never populate this from a request payload. */
  origin: string;
  /** Exact server-controlled origins this process is permitted to call. */
  allowedOrigins: readonly string[];
  /** Optional bearer token for protected self-hosted chat APIs. Public bots need no token. */
  accessToken?: string;
  /** Server-owned test or egress-enforcing transport override. Never select it from request data. */
  fetch?: TypebotFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_CONFIGURED_RESPONSE_BYTES = 16_777_216;
const MAX_ACCESS_TOKEN_BYTES = 4_096;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_TEXT_BYTES = 4_096;

function clientError(code: TypebotClientErrorCode): TypebotClientError {
  return new TypebotClientError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const first = octets[0] as number;
  const second = octets[1] as number;
  const third = octets[2] as number;
  return !(first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224);
}

function isPublicIpv6(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) !== 6) return false;
  const firstHextet = Number.parseInt(value.split(':', 1)[0] as string, 16);
  return firstHextet >= 0x2000
    && firstHextet <= 0x3fff
    && !value.startsWith('2001:db8:');
}

function isPublicAddress(address: string, family?: 4 | 6): boolean {
  const detectedFamily = isIP(address);
  if (family !== undefined && detectedFamily !== family) return false;
  if (detectedFamily === 4) return isPublicIpv4(address);
  if (detectedFamily === 6) return isPublicIpv6(address);
  return false;
}

function normalizeOrigin(value: unknown): URL {
  try {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
      throw clientError('INVALID_CONFIGURATION');
    }
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const hostnameWithoutTrailingDot = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
      || (url.pathname !== '' && url.pathname !== '/')
      || hostnameWithoutTrailingDot === 'localhost'
      || hostnameWithoutTrailingDot.endsWith('.localhost')
      || (isIP(hostnameWithoutTrailingDot.replace(/^\[|\]$/g, '')) !== 0
        && !isPublicAddress(hostnameWithoutTrailingDot.replace(/^\[|\]$/g, '')))
    ) {
      throw clientError('INVALID_CONFIGURATION');
    }
    url.hostname = hostnameWithoutTrailingDot;
    url.pathname = '/';
    return url;
  } catch (error) {
    if (error instanceof TypebotClientError) throw error;
    throw clientError('INVALID_CONFIGURATION');
  }
}

function validatePositiveInteger(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw clientError('INVALID_CONFIGURATION');
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || utf8ByteLength(value) > MAX_IDENTIFIER_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw clientError('INVALID_ARGUMENT');
  }
}

function validateText(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || utf8ByteLength(value) > MAX_TEXT_BYTES
    || value.includes('\u0000')
  ) {
    throw clientError('INVALID_ARGUMENT');
  }
}

const defaultHostLookup: TypebotHostLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.flatMap((result) => (
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : []
  ));
};

const defaultPinnedDispatch: TypebotPinnedDispatch = async (request) => new Promise<Response>(
  (resolve, reject) => {
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = request.hostHeader;
    const outgoing = httpsRequest({
      protocol: 'https:',
      hostname: request.address,
      family: request.family,
      port: request.url.port === '' ? 443 : Number(request.url.port),
      method: request.method,
      path: `${request.url.pathname}${request.url.search}`,
      headers,
      servername: request.servername,
      signal: request.signal,
    }, (incoming) => {
      const status = incoming.statusCode;
      if (status === undefined || status < 200 || status > 599) {
        incoming.destroy();
        reject(new Error('Invalid upstream status'));
        return;
      }
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index];
        const value = incoming.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
      }
      try {
        const hasNoBody = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
        resolve(new Response(
          hasNoBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          {
            status,
            ...(incoming.statusMessage === undefined ? {} : { statusText: incoming.statusMessage }),
            headers: responseHeaders,
          },
        ));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    outgoing.once('error', reject);
    if (request.body === undefined) outgoing.end();
    else outgoing.end(request.body);
  },
);

/**
 * Creates an HTTPS-only transport that validates every DNS answer and connects to
 * the selected address directly while retaining the original TLS server name.
 */
export function createPinnedTypebotFetch(
  options: TypebotPinnedFetchOptions = {},
): TypebotFetch {
  const lookup = options.lookup ?? defaultHostLookup;
  const dispatch = options.dispatch ?? defaultPinnedDispatch;
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const servername = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || servername === 'localhost'
      || servername.endsWith('.localhost')
    ) {
      throw clientError('INVALID_CONFIGURATION');
    }

    const literalFamily = isIP(servername);
    let addresses: readonly TypebotResolvedAddress[];
    if (literalFamily === 4 || literalFamily === 6) {
      addresses = [{ address: servername, family: literalFamily }];
    } else {
      addresses = await lookup(servername);
    }
    if (
      addresses.length === 0
      || addresses.some(({ address, family }) => !isPublicAddress(address, family))
    ) {
      throw clientError('INVALID_CONFIGURATION');
    }
    if (request.signal.aborted) throw request.signal.reason;

    const selected = addresses[0] as TypebotResolvedAddress;
    const body = request.body === null
      ? undefined
      : new Uint8Array(await request.arrayBuffer());
    if (request.signal.aborted) throw request.signal.reason;
    return dispatch({
      url,
      address: selected.address,
      family: selected.family,
      servername,
      hostHeader: url.host,
      method: request.method,
      headers: request.headers,
      ...(body === undefined ? {} : { body }),
      signal: request.signal,
    });
  };
}

function parseContentLength(response: Response, maximum: number): void {
  const header = response.headers.get('content-length');
  if (header === null) return;
  if (!/^\d+$/.test(header)) throw clientError('INVALID_RESPONSE');
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw clientError('INVALID_RESPONSE');
  if (length > maximum) throw clientError('RESPONSE_TOO_LARGE');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  try {
    parseContentLength(response, maximum);
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) throw clientError('RESPONSE_TOO_LARGE');
      try {
        text += decoder.decode(result.value, { stream: true });
      } catch {
        throw clientError('INVALID_RESPONSE');
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw clientError('INVALID_RESPONSE');
    }
    return text;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof TypebotClientError) throw error;
    throw clientError('UNKNOWN');
  } finally {
    reader.releaseLock();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw clientError('INVALID_RESPONSE');
  }
}

function parseChatResponse(
  body: unknown,
): Omit<TypebotChatResult, 'sessionId'> {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw clientError('INVALID_RESPONSE');
  }

  const texts: string[] = [];
  const incompatibilities: TypebotIncompatibility[] = [];
  for (const message of body.messages) {
    if (
      !isRecord(message)
      || typeof message.id !== 'string'
      || message.id.length === 0
      || typeof message.type !== 'string'
      || message.type.length === 0
    ) {
      throw clientError('INVALID_RESPONSE');
    }
    if (message.type !== 'text') {
      incompatibilities.push({
        kind: 'UNSUPPORTED_MESSAGE',
        id: message.id,
        type: message.type,
      });
      continue;
    }
    if (
      !isRecord(message.content)
      || message.content.type !== 'markdown'
      || typeof message.content.markdown !== 'string'
    ) {
      throw clientError('INVALID_RESPONSE');
    }
    texts.push(message.content.markdown);
  }

  let input: TypebotInputInfo | undefined;
  if (body.input !== undefined && body.input !== null) {
    if (
      !isRecord(body.input)
      || typeof body.input.id !== 'string'
      || body.input.id.length === 0
      || typeof body.input.type !== 'string'
      || body.input.type.length === 0
    ) {
      throw clientError('INVALID_RESPONSE');
    }
    input = { id: body.input.id, type: body.input.type };
    if (input.type !== 'text input') {
      incompatibilities.push({
        kind: 'UNSUPPORTED_INPUT',
        id: input.id,
        type: input.type,
      });
    }
  }

  if (body.clientSideActions !== undefined && body.clientSideActions !== null) {
    if (!Array.isArray(body.clientSideActions)) throw clientError('INVALID_RESPONSE');
    for (const action of body.clientSideActions) {
      if (!isRecord(action) || typeof action.type !== 'string' || action.type.length === 0) {
        throw clientError('INVALID_RESPONSE');
      }
      incompatibilities.push({ kind: 'CLIENT_SIDE_ACTION', type: action.type });
    }
  }

  return {
    texts,
    ...(input === undefined ? {} : { input }),
    incompatibilities,
  };
}

export class TypebotClient {
  readonly #accessToken: string | undefined;
  readonly #fetch: TypebotFetch;
  readonly #maxResponseBytes: number;
  readonly #origin: URL;
  readonly #timeoutMs: number;

  constructor(options: TypebotClientOptions) {
    if (!isRecord(options)) throw clientError('INVALID_CONFIGURATION');
    const origin = normalizeOrigin(options.origin);
    if (!Array.isArray(options.allowedOrigins) || options.allowedOrigins.length === 0) {
      throw clientError('INVALID_CONFIGURATION');
    }
    const allowedOrigins = options.allowedOrigins.map((allowed) => normalizeOrigin(allowed).origin);
    if (!allowedOrigins.includes(origin.origin)) throw clientError('INVALID_CONFIGURATION');

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    validatePositiveInteger(timeoutMs, MAX_TIMER_MS);
    validatePositiveInteger(maxResponseBytes, MAX_CONFIGURED_RESPONSE_BYTES);
    if (options.fetch !== undefined && typeof options.fetch !== 'function') {
      throw clientError('INVALID_CONFIGURATION');
    }
    if (options.accessToken !== undefined && (
      typeof options.accessToken !== 'string'
      || options.accessToken.length === 0
      || utf8ByteLength(options.accessToken) > MAX_ACCESS_TOKEN_BYTES
      || /[\r\n]/.test(options.accessToken)
    )) {
      throw clientError('INVALID_CONFIGURATION');
    }

    this.#origin = origin;
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? createPinnedTypebotFetch();
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  async startChat(publicId: string, text?: string): Promise<TypebotChatResult> {
    validateIdentifier(publicId);
    if (text !== undefined) validateText(text);
    const response = await this.#request(
      `api/v1/typebots/${encodeURIComponent(publicId)}/startChat`,
      {
        ...(text === undefined ? {} : { message: { type: 'text', text } }),
        textBubbleContentFormat: 'markdown',
      },
      false,
    );
    if (
      !isRecord(response)
      || typeof response.sessionId !== 'string'
      || response.sessionId.length === 0
    ) {
      throw clientError('INVALID_RESPONSE');
    }
    return {
      sessionId: response.sessionId,
      ...parseChatResponse(response),
    };
  }

  async continueChat(sessionId: string, text: string): Promise<TypebotChatResult> {
    validateIdentifier(sessionId);
    validateText(text);
    const response = await this.#request(
      `api/v1/sessions/${encodeURIComponent(sessionId)}/continueChat`,
      {
        message: { type: 'text', text },
        textBubbleContentFormat: 'markdown',
      },
      true,
    );
    return {
      sessionId,
      ...parseChatResponse(response),
    };
  }

  async #request(path: string, body: unknown, isContinue: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    if (this.#accessToken !== undefined) {
      headers.set('authorization', `Bearer ${this.#accessToken}`);
    }

    let response: Response;
    try {
      response = await abortable(
        Promise.resolve().then(() => this.#fetch(new URL(path, this.#origin), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
        })),
        controller.signal,
      );
    } catch {
      clearTimeout(timer);
      throw clientError('UNKNOWN');
    }

    try {
      if (isContinue && response.status === 404) throw clientError('SESSION_EXPIRED');
      if (response.status >= 500) throw clientError('UNKNOWN');
      if (!response.ok) throw clientError('UPSTREAM_ERROR');
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') throw clientError('INVALID_RESPONSE');
      const responseText = await readBoundedBody(
        response,
        this.#maxResponseBytes,
        controller.signal,
      );
      return parseJson(responseText);
    } catch (error) {
      if (error instanceof TypebotClientError) throw error;
      if (controller.signal.aborted) throw clientError('UNKNOWN');
      throw clientError('INVALID_RESPONSE');
    } finally {
      clearTimeout(timer);
    }
  }
}
