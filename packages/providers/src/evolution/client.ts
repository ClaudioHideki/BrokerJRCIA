import type { ProviderContext } from '../contracts/types.js';

export type EvolutionProviderErrorCode =
  | 'INVALID_EVOLUTION_CONFIGURATION'
  | 'INVALID_PROVIDER_CONTEXT'
  | 'PROVIDER_ABORTED'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_REQUEST_FAILED'
  | 'PROVIDER_TIMEOUT';

export interface EvolutionProviderError extends Error {
  code: EvolutionProviderErrorCode;
}

export type EvolutionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface EvolutionClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: EvolutionFetch;
  now?: () => Date;
}

export interface EvolutionRequest {
  method: 'DELETE' | 'GET' | 'POST';
  path: string;
  body?: unknown;
  allowNotFound?: boolean;
}

export type EvolutionResponse =
  | { found: false }
  | { found: true; body: unknown };

export function evolutionProviderError(code: EvolutionProviderErrorCode): EvolutionProviderError {
  return Object.assign(new Error(code), {
    name: 'EvolutionProviderError',
    code,
  });
}

function normalizeBaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
      || (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw evolutionProviderError('INVALID_EVOLUTION_CONFIGURATION');
    }
    url.pathname = '/';
    return url;
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'INVALID_EVOLUTION_CONFIGURATION'
    ) {
      throw error;
    }
    throw evolutionProviderError('INVALID_EVOLUTION_CONFIGURATION');
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw evolutionProviderError('INVALID_EVOLUTION_CONFIGURATION');
  }
}

function safeJson(text: string): unknown {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
  }
}

export class EvolutionOperation {
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #fetch: EvolutionFetch;
  readonly #requestId: string;
  readonly #signal: AbortSignal;
  readonly #callerSignal: AbortSignal;
  readonly #timeoutSignal: AbortSignal;

  constructor(options: {
    apiKey: string;
    baseUrl: URL;
    fetch: EvolutionFetch;
    context: ProviderContext;
    timeoutMs: number;
    now: Date;
  }) {
    const { context } = options;
    if (
      !(context.deadline instanceof Date)
      || !Number.isFinite(context.deadline.getTime())
      || !(context.signal instanceof AbortSignal)
    ) {
      throw evolutionProviderError('INVALID_PROVIDER_CONTEXT');
    }
    if (context.signal.aborted) {
      throw evolutionProviderError('PROVIDER_ABORTED');
    }

    validateTimeout(options.timeoutMs);
    const deadlineRemainingMs = context.deadline.getTime() - options.now.getTime();
    if (deadlineRemainingMs <= 0) {
      throw evolutionProviderError('PROVIDER_TIMEOUT');
    }

    const effectiveTimeoutMs = Math.max(
      1,
      Math.min(options.timeoutMs, Math.ceil(deadlineRemainingMs)),
    );
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetch;
    this.#requestId = context.requestId;
    this.#callerSignal = context.signal;
    this.#timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
    this.#signal = AbortSignal.any([this.#callerSignal, this.#timeoutSignal]);
  }

  async request(request: EvolutionRequest): Promise<EvolutionResponse> {
    const headers = new Headers({
      accept: 'application/json',
      apikey: this.#apiKey,
      'x-request-id': this.#requestId,
    });
    let body: string | undefined;
    if (request.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(request.body);
    }

    let response: Response;
    try {
      response = await this.#fetch(new URL(request.path, this.#baseUrl), {
        method: request.method,
        headers,
        redirect: 'error',
        signal: this.#signal,
        ...(body === undefined ? {} : { body }),
      });
    } catch {
      this.#throwIfInterrupted();
      throw evolutionProviderError('PROVIDER_REQUEST_FAILED');
    }

    if (request.allowNotFound === true && response.status === 404) {
      return { found: false };
    }
    if (!response.ok) {
      throw evolutionProviderError('PROVIDER_REQUEST_FAILED');
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      this.#throwIfInterrupted();
      throw evolutionProviderError('PROVIDER_INVALID_RESPONSE');
    }
    return { found: true, body: safeJson(text) };
  }

  async wait(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
      throw evolutionProviderError('INVALID_EVOLUTION_CONFIGURATION');
    }
    this.#throwIfInterrupted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        this.#signal.removeEventListener('abort', onAbort);
        try {
          this.#throwIfInterrupted();
        } catch (error) {
          reject(error);
        }
      };
      this.#signal.addEventListener('abort', onAbort, { once: true });
      if (this.#signal.aborted) {
        onAbort();
      }
    });
  }

  #throwIfInterrupted(): void {
    if (this.#callerSignal.aborted) {
      throw evolutionProviderError('PROVIDER_ABORTED');
    }
    if (this.#timeoutSignal.aborted || this.#signal.aborted) {
      throw evolutionProviderError('PROVIDER_TIMEOUT');
    }
  }
}

export class EvolutionClient {
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #fetch: EvolutionFetch;
  readonly #now: () => Date;

  constructor(options: EvolutionClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw evolutionProviderError('INVALID_EVOLUTION_CONFIGURATION');
    }
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  beginOperation(context: ProviderContext, timeoutMs: number): EvolutionOperation {
    return new EvolutionOperation({
      apiKey: this.#apiKey,
      baseUrl: this.#baseUrl,
      fetch: this.#fetch,
      context,
      timeoutMs,
      now: this.#now(),
    });
  }
}
