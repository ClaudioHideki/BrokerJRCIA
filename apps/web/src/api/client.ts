import {
  CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE,
  ConsoleSessionResponseSchema,
  LoginOrganizationsSchema,
  type ConsoleSelectOrganizationRequest,
  type ConsoleSessionResponse,
  type ConsoleSwitchOrganizationRequest,
  type LoginOrganizations,
  type LoginRequest,
} from "@jrc/contracts";

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NON_RETRIABLE_PATHS = new Set([
  "/v1/auth/login",
  "/v1/console/auth/restore",
  "/v1/console/auth/logout",
]);
const COOKIE_AUTH_PATHS = new Set([
  "/v1/console/auth/restore",
  "/v1/console/auth/switch-organization",
  "/v1/console/auth/logout",
]);

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly code?: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export class StaleTenantResponseError extends Error {
  constructor() {
    super("A resposta pertence a uma organização que não está mais ativa.");
    this.name = "StaleTenantResponseError";
  }
}

export type BrowserSession = Pick<
  ConsoleSessionResponse,
  "user" | "activeOrganization" | "organizations"
>;

export interface ApiClient {
  login(input: LoginRequest): Promise<LoginOrganizations>;
  selectOrganization(
    input: ConsoleSelectOrganizationRequest,
  ): Promise<BrowserSession>;
  restore(): Promise<BrowserSession>;
  switchOrganization(
    input: ConsoleSwitchOrganizationRequest,
  ): Promise<BrowserSession>;
  logout(): Promise<void>;
  request<T>(
    path: string,
    init?: RequestInit & { responseType?: "blob" },
  ): Promise<T>;
  registerTenantPurge(handler: () => void): () => void;
  subscribeToSessionExpiration(listener: () => void): () => void;
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  cookieSource?: () => string;
  cookieSink?: (serializedCookie: string) => void;
}

const EXPIRED_CSRF_COOKIES = [
  "jrc_csrf=; Max-Age=0; Path=/; SameSite=Strict",
  "__Host-jrc_csrf=; Max-Age=0; Path=/; Secure; SameSite=Strict",
] as const;

function browserSession(value: ConsoleSessionResponse): BrowserSession {
  return {
    user: value.user,
    activeOrganization: value.activeOrganization,
    organizations: value.organizations,
  };
}

function assertRelativeApiPath(path: string): void {
  if (!/^\/v1(?:\/|\?|$)/.test(path) || path.startsWith("//")) {
    throw new Error(
      "A API aceita somente caminhos relativos iniciados por /v1.",
    );
  }
}

function readCsrfCookie(cookieHeader: string): string | null {
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== "__Host-jrc_csrf" && name !== "jrc_csrf") continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function safeRequestId(candidate: unknown): string | undefined {
  return typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function messageFor(status: number, path: string, code?: string): string {
  if (status === 401 && path === "/v1/auth/login")
    return "E-mail ou senha inválidos.";
  if (status === 401) return "Sua sessão expirou. Entre novamente.";
  if (
    status === 409 &&
    path === "/v1/console/auth/switch-organization" &&
    code === CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE
  ) {
    return "Não foi possível trocar de organização. Sua sessão atual foi mantida.";
  }
  if (status === 403) return "Você não tem permissão para realizar esta ação.";
  if (status === 404) return "O recurso solicitado não foi encontrado.";
  if (status === 429) return "Muitas tentativas. Aguarde e tente novamente.";
  if (status >= 500)
    return "Serviço temporariamente indisponível. Tente novamente.";
  return "Revise os dados informados e tente novamente.";
}

async function errorFor(
  response: Response,
  path: string,
): Promise<ApiClientError> {
  let body: unknown;
  if (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/problem+json")
  ) {
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
  }
  const problem =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : undefined;
  const requestId =
    safeRequestId(problem?.requestId) ??
    safeRequestId(response.headers.get("x-request-id"));
  const reportedCorrelationId = safeRequestId(problem?.correlationId);
  const correlationId = reportedCorrelationId === requestId
    ? reportedCorrelationId
    : requestId;
  const code =
    typeof problem?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(problem.code)
      ? problem.code
      : undefined;
  return new ApiClientError(
    messageFor(response.status, path, code),
    response.status,
    requestId,
    code,
    correlationId,
  );
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cookieSource = options.cookieSource ?? (() => document.cookie);
  const cookieSink =
    options.cookieSink ??
    ((serializedCookie: string) => {
      document.cookie = serializedCookie;
    });
  let accessToken: string | null = null;
  let accessTokenVersion = 0;
  let restoreFlight: {
    tokenVersion: number;
    generation: number;
    promise: Promise<BrowserSession>;
  } | null = null;
  let switchQueue: Promise<void> = Promise.resolve();
  let logoutOperations = 0;
  let tenantGeneration = 0;
  const tenantControllers = new Set<AbortController>();
  const purgeHandlers = new Set<() => void>();
  const expirationListeners = new Set<() => void>();

  function expireSession(): void {
    if (accessToken === null) return;
    accessToken = null;
    accessTokenVersion += 1;
    for (const listener of expirationListeners) listener();
  }

  function discardAccessToken(): void {
    if (accessToken === null) return;
    accessToken = null;
    accessTokenVersion += 1;
  }

  function publishAccessToken(token: string): void {
    accessToken = token;
    accessTokenVersion += 1;
  }

  function clearBrowserCsrfCookies(): void {
    for (const serializedCookie of EXPIRED_CSRF_COOKIES)
      cookieSink(serializedCookie);
  }

  function assertCurrentTenantGeneration(generation: number | undefined): void {
    if (generation !== undefined && generation !== tenantGeneration) {
      throw new StaleTenantResponseError();
    }
  }

  function purgeTenant(): number {
    tenantGeneration += 1;
    for (const controller of tenantControllers) controller.abort();
    tenantControllers.clear();
    for (const handler of purgeHandlers) handler();
    return tenantGeneration;
  }

  function headersFor(
    path: string,
    init: RequestInit,
    includeBearer: boolean,
  ): Headers {
    const headers = new Headers(init.headers);
    if (
      init.body !== undefined &&
      init.body !== null &&
      !headers.has("content-type")
    ) {
      headers.set("content-type", "application/json");
    }
    if (includeBearer && accessToken !== null) {
      headers.set("authorization", `Bearer ${accessToken}`);
    }
    if (COOKIE_AUTH_PATHS.has(path) || /^\/v1\/embed\/authorizations\/[0-9a-f-]{36}\/(approve|deny)$/u.test(path)) {
      const csrf = readCsrfCookie(cookieSource());
      if (csrf !== null) headers.set("x-csrf-token", csrf);
    }
    return headers;
  }

  async function fetchOnce(
    path: string,
    init: RequestInit,
    options: { bearer: boolean; trackTenant: boolean; generation?: number },
  ): Promise<Response> {
    assertRelativeApiPath(path);
    const generation = options.trackTenant
      ? (options.generation ?? tenantGeneration)
      : undefined;
    assertCurrentTenantGeneration(generation);
    const controller = options.trackTenant ? new AbortController() : null;
    if (controller) tenantControllers.add(controller);
    const externalSignal = init.signal;
    const signal =
      controller === null
        ? externalSignal
        : externalSignal === null || externalSignal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, externalSignal]);
    try {
      const response = await fetchImpl(path, {
        ...init,
        credentials: "same-origin",
        headers: headersFor(path, init, options.bearer),
        ...(signal ? { signal } : {}),
      });
      assertCurrentTenantGeneration(generation);
      return response;
    } catch (error) {
      assertCurrentTenantGeneration(generation);
      if (
        error instanceof ApiClientError ||
        error instanceof StaleTenantResponseError
      )
        throw error;
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      throw new ApiClientError(
        "Não foi possível acessar o serviço. Tente novamente.",
        0,
      );
    } finally {
      if (controller) tenantControllers.delete(controller);
    }
  }

  async function parseJson<T>(
    response: Response,
    path: string,
    generation?: number,
    binary = false,
  ): Promise<T> {
    assertCurrentTenantGeneration(generation);
    if (!response.ok) {
      const error = await errorFor(response, path);
      assertCurrentTenantGeneration(generation);
      throw error;
    }
    if (response.status === 204) return undefined as T;
    try {
      const body = (
        binary ? await response.blob() : await response.json()
      ) as T;
      assertCurrentTenantGeneration(generation);
      return body;
    } catch (error) {
      assertCurrentTenantGeneration(generation);
      if (error instanceof StaleTenantResponseError) throw error;
      throw new ApiClientError(
        "O serviço retornou uma resposta inválida.",
        502,
      );
    }
  }

  async function restoreSession(expected?: {
    tokenVersion: number;
    generation: number;
  }): Promise<BrowserSession> {
    const path = "/v1/console/auth/restore";
    const response = await fetchOnce(
      path,
      { method: "POST" },
      {
        bearer: false,
        trackTenant: false,
      },
    );
    const parsed = ConsoleSessionResponseSchema.safeParse(
      await parseJson<unknown>(response, path, expected?.generation),
    );
    if (!parsed.success)
      throw new ApiClientError(
        "O serviço retornou uma resposta inválida.",
        502,
      );
    if (expected !== undefined) {
      assertCurrentTenantGeneration(expected.generation);
      if (expected.tokenVersion !== accessTokenVersion) {
        throw new StaleTenantResponseError();
      }
    }
    publishAccessToken(parsed.data.accessToken);
    return browserSession(parsed.data);
  }

  async function singleFlightRestore(
    tokenVersion: number,
    generation: number,
  ): Promise<BrowserSession> {
    if (tokenVersion !== accessTokenVersion) {
      throw new StaleTenantResponseError();
    }
    if (restoreFlight !== null) {
      if (
        restoreFlight.tokenVersion === tokenVersion &&
        restoreFlight.generation === generation
      ) {
        return restoreFlight.promise;
      }
      throw new StaleTenantResponseError();
    }
    const promise = restoreSession({ tokenVersion, generation }).finally(() => {
      if (restoreFlight?.promise === promise) restoreFlight = null;
    });
    restoreFlight = { tokenVersion, generation, promise };
    return promise;
  }

  async function authenticatedRequest<T>(
    path: string,
    init: RequestInit & { responseType?: "blob" } = {},
  ): Promise<T> {
    const generation = tenantGeneration;
    const requestTokenVersion = accessTokenVersion;
    let response = await fetchOnce(path, init, {
      bearer: true,
      trackTenant: true,
      generation,
    });
    if (
      response.status !== 401 ||
      NON_RETRIABLE_PATHS.has(path) ||
      accessToken === null
    ) {
      return parseJson<T>(
        response,
        path,
        generation,
        init.responseType === "blob",
      );
    }
    try {
      if (requestTokenVersion === accessTokenVersion) {
        await singleFlightRestore(requestTokenVersion, generation);
      }
    } catch (error) {
      if (error instanceof StaleTenantResponseError) throw error;
      assertCurrentTenantGeneration(generation);
      expireSession();
      throw error;
    }
    const retryTokenVersion = accessTokenVersion;
    response = await fetchOnce(path, init, {
      bearer: true,
      trackTenant: true,
      generation,
    });
    if (response.status === 401 && retryTokenVersion === accessTokenVersion)
      expireSession();
    return parseJson<T>(
      response,
      path,
      generation,
      init.responseType === "blob",
    );
  }

  async function sessionMutation(
    path: string,
    body: unknown,
    options: {
      bearer: boolean;
      generation?: number;
      expireOnUncertain?: boolean;
    },
  ): Promise<BrowserSession> {
    const requestTokenVersion = accessTokenVersion;
    let retryTokenVersion: number | null = null;
    let retriedAfterTokenChange = false;
    let response: Response;
    try {
      response = await fetchOnce(
        path,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        { bearer: options.bearer, trackTenant: false },
      );
    } catch (error) {
      if (options.expireOnUncertain) expireSession();
      throw error;
    }
    if (
      response.status === 401 &&
      options.bearer &&
      accessToken !== null &&
      !NON_RETRIABLE_PATHS.has(path)
    ) {
      try {
        const generation = options.generation ?? tenantGeneration;
        if (requestTokenVersion === accessTokenVersion) {
          await singleFlightRestore(requestTokenVersion, generation);
        }
      } catch (error) {
        if (error instanceof StaleTenantResponseError) throw error;
        expireSession();
        throw error;
      }
      try {
        retriedAfterTokenChange = requestTokenVersion !== accessTokenVersion;
        retryTokenVersion = accessTokenVersion;
        response = await fetchOnce(
          path,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
          { bearer: true, trackTenant: false },
        );
        if (
          response.status === 401 &&
          retryTokenVersion === accessTokenVersion
        ) {
          expireSession();
        }
      } catch (error) {
        if (options.expireOnUncertain) expireSession();
        throw error;
      }
    }
    if (!response.ok) {
      let responseError: unknown;
      try {
        return await parseJson<ConsoleSessionResponse>(
          response,
          path,
          options.generation,
        );
      } catch (error) {
        responseError = error;
      }
      const sourceSessionPreserved =
        responseError instanceof ApiClientError &&
        responseError.status === 409 &&
        responseError.code === CONSOLE_ORGANIZATION_SWITCH_REJECTED_CODE;
      const retryStillOwnsToken =
        retryTokenVersion !== null && retryTokenVersion === accessTokenVersion;
      if (
        options.expireOnUncertain &&
        (response.status >= 500 ||
          (response.status === 409 && !sourceSessionPreserved) ||
          (retriedAfterTokenChange && retryStillOwnsToken))
      ) {
        expireSession();
      }
      throw responseError;
    }
    try {
      const parsed = ConsoleSessionResponseSchema.safeParse(
        await parseJson<unknown>(response, path, options.generation),
      );
      if (!parsed.success)
        throw new ApiClientError(
          "O serviço retornou uma resposta inválida.",
          502,
        );
      assertCurrentTenantGeneration(options.generation);
      publishAccessToken(parsed.data.accessToken);
      return browserSession(parsed.data);
    } catch (error) {
      if (options.expireOnUncertain) expireSession();
      throw error;
    }
  }

  return {
    async login(input) {
      const path = "/v1/auth/login";
      const response = await fetchOnce(
        path,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
        { bearer: false, trackTenant: false },
      );
      const parsed = LoginOrganizationsSchema.safeParse(
        await parseJson<unknown>(response, path),
      );
      if (!parsed.success)
        throw new ApiClientError(
          "O serviço retornou uma resposta inválida.",
          502,
        );
      return parsed.data;
    },

    selectOrganization(input) {
      return sessionMutation("/v1/console/auth/select-organization", input, {
        bearer: false,
      });
    },

    restore() {
      if (logoutOperations > 0)
        return Promise.reject(new StaleTenantResponseError());
      return singleFlightRestore(accessTokenVersion, tenantGeneration);
    },

    switchOrganization(input) {
      if (logoutOperations > 0) {
        return Promise.reject(
          new ApiClientError("Sua sessão expirou. Entre novamente.", 401),
        );
      }
      const run = async () => {
        if (accessToken === null) {
          throw new ApiClientError("Sua sessão expirou. Entre novamente.", 401);
        }
        const pendingRestore = restoreFlight?.promise;
        const generation = purgeTenant();
        if (pendingRestore) {
          try {
            await pendingRestore;
          } catch (error) {
            if (!(error instanceof StaleTenantResponseError)) {
              expireSession();
              throw error;
            }
          }
        }
        return sessionMutation("/v1/console/auth/switch-organization", input, {
          bearer: true,
          generation,
          expireOnUncertain: true,
        });
      };
      const result = switchQueue.then(run, run);
      switchQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    async logout() {
      logoutOperations += 1;
      const csrfBeforePendingOperations = readCsrfCookie(cookieSource());
      clearBrowserCsrfCookies();
      try {
        const pendingRestore = restoreFlight?.promise;
        const pendingSwitch = switchQueue;
        purgeTenant();
        discardAccessToken();
        await Promise.all([
          pendingSwitch,
          pendingRestore?.catch(() => undefined) ?? Promise.resolve(),
        ]);
        // A completed switch/restore may have installed a newer cookie before this final clear.
        discardAccessToken();
        const csrfForLogout =
          readCsrfCookie(cookieSource()) ?? csrfBeforePendingOperations;
        clearBrowserCsrfCookies();
        const path = "/v1/console/auth/logout";
        const response = await fetchOnce(
          path,
          {
            method: "POST",
            ...(csrfForLogout === null
              ? {}
              : { headers: { "x-csrf-token": csrfForLogout } }),
          },
          {
            bearer: false,
            trackTenant: false,
          },
        );
        await parseJson<void>(response, path);
      } finally {
        discardAccessToken();
        clearBrowserCsrfCookies();
        logoutOperations -= 1;
      }
    },

    request: authenticatedRequest,

    registerTenantPurge(handler) {
      purgeHandlers.add(handler);
      return () => purgeHandlers.delete(handler);
    },

    subscribeToSessionExpiration(listener) {
      expirationListeners.add(listener);
      return () => expirationListeners.delete(listener);
    },
  };
}
