import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";

import type { InstanceService } from "../modules/instances/service.js";
import type { ProviderAccountService } from "../modules/provider-accounts/service.js";
import type { MessagingService } from "./routes/messaging.js";
import { buildApp } from "../app.js";

type JsonObject = Record<string, unknown>;

const DOCUMENTATION_SECRET = "documentation-secret-with-at-least-32-bytes";
const PROTECTED_PATH_PREFIXES = [
  "/v1/api-keys",
  "/v1/instances",
  "/v1/provider-accounts",
];
const CONSOLE_AUTH_PATH_PREFIX = "/v1/console/auth/";

function documentationOptions() {
  const unavailable = async () => {
    throw new Error("Documentation handler is not executable");
  };
  const instanceService = new Proxy(
    {},
    {
      get() {
        return unavailable;
      },
    },
  ) as InstanceService;
  const providerAccountService = new Proxy(
    {},
    {
      get() {
        return unavailable;
      },
    },
  ) as ProviderAccountService;
  return {
    flows: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as ReturnType<typeof import('../modules/flows/service.js').createFlowService>,
      chatwoot: new Proxy({}, { get() { return unavailable; } }) as ReturnType<typeof import('../modules/flows/chatwoot-service.js').createFlowChatwootService>,
    },
    chatwootEmbed: {
      nodeEnv: 'test' as const, jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable,
      browserCsrfSecret: DOCUMENTATION_SECRET, browserCookieSecure: true, consoleAllowedOrigins: ['https://console.example.test'], trustedProxyCidrs: [],
      service: new Proxy({}, { get() { return unavailable; } }) as import('../modules/integrations/embed/authorization.js').EmbedAuthorizationService,
    },
    chatwootControl: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as import('../modules/integrations/chatwoot-control-auth.js').ChatwootControlAuth,
    },
    integrations: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      resolveCurrentRole: unavailable,
      service: new Proxy(
        {},
        {
          get() {
            return unavailable;
          },
        },
      ) as import("../modules/integrations/chatwoot-service.js").ChatwootService,
    },
    platform: {
      service: new Proxy(
        {},
        {
          get() {
            return unavailable;
          },
        },
      ) as import("../modules/platform/service.js").PlatformService,
      origin: "https://console.example.test",
      secureCookies: true,
    },
    metaOnboarding: {
      service: new Proxy(
        {},
        {
          get() {
            return unavailable;
          },
        },
      ) as ReturnType<
        typeof import("../modules/meta-onboarding/service.js").createMetaOnboardingService
      >,
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      resolveCurrentRole: unavailable,
    },
    instanceWorkspace: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      service: new Proxy(
        {},
        {
          get() {
            return unavailable;
          },
        },
      ) as import("../modules/instances/workspace.js").InstanceWorkspaceService,
    },
    tenantOperations: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      transact: unavailable,
    },
    nodeEnv: "test" as const,
    metaWebhooks: {
      appSecret: DOCUMENTATION_SECRET,
      verifyToken: DOCUMENTATION_SECRET,
      ingest: unavailable,
    },
    messaging: {
      resolveCurrentRole: unavailable,
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      service: new Proxy(
        {},
        {
          get() {
            return unavailable;
          },
        },
      ) as MessagingService,
    },
    passwordVerifierInitializer: async () => ({
      async verifyPasswordOrDummy() {
        return false;
      },
    }),
    auth: {
      repository: {} as never,
      rateLimitStore: {
        kind: "memory" as const,
        async consume() {
          return {
            allowed: true,
            count: 0,
            remaining: 1,
            retryAfterMs: 0,
            released: false,
          };
        },
      },
      writeSecurityAudit: unavailable,
      writeOrganizationSelectedAudit: unavailable,
      ipRateLimitHmacSecret: `${DOCUMENTATION_SECRET}-ip`,
      identityRateLimitHmacSecret: `${DOCUMENTATION_SECRET}-identity`,
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      refreshTokenHashSecret: `${DOCUMENTATION_SECRET}-refresh`,
      trustedProxyCidrs: [],
    },
    consoleAuth: {
      repository: {} as never,
      rateLimitStore: {
        kind: "memory" as const,
        async consume() {
          return {
            allowed: true,
            count: 0,
            remaining: 1,
            retryAfterMs: 0,
            released: false,
          };
        },
      },
      writeSecurityAudit: unavailable,
      writeOrganizationSelectedAudit: unavailable,
      ipRateLimitHmacSecret: `${DOCUMENTATION_SECRET}-ip`,
      identityRateLimitHmacSecret: `${DOCUMENTATION_SECRET}-identity`,
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      refreshTokenHashSecret: `${DOCUMENTATION_SECRET}-refresh`,
      browserCsrfSecret: `${DOCUMENTATION_SECRET}-browser-csrf`,
      consoleAllowedOrigins: ["https://console.example.test"],
      browserCookieSecure: true,
      trustedProxyCidrs: [],
    },
    apiKeys: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      issueApiKey: unavailable,
      listApiKeys: unavailable,
      revokeApiKey: unavailable,
    },
    providerAccounts: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      service: providerAccountService,
    },
    instances: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      service: instanceService,
    },
  };
}

function normalizeDocument(document: JsonObject): JsonObject {
  const components = (document.components ??= {}) as JsonObject;
  components.securitySchemes = {
    ...((components.securitySchemes ?? {}) as JsonObject),
    platformSession: {
      type: "apiKey",
      in: "cookie",
      name: "platform_session",
      description:
        "Sessão administrativa curta emitida conforme o modo de login configurado, separada de JWT de organização.",
    },
    chatwootSignature: {
      type: "apiKey",
      in: "header",
      name: "X-Chatwoot-Signature",
      description:
        "HMAC-SHA256 do timestamp e corpo original. X-Chatwoot-Timestamp obrigatório, tolerância de cinco minutos.",
    },
    platformCsrf: { type: "apiKey", in: "header", name: "x-csrf-token" },
    metaSignature: {
      type: "apiKey",
      in: "header",
      name: "X-Hub-Signature-256",
      description:
        "sha256= seguido do HMAC-SHA256 dos bytes originais, assinado com o App Secret Meta.",
    },
  };
  components.headers = {
    ...((components.headers ?? {}) as JsonObject),
    CacheControl: {
      description: "Impede armazenamento de respostas sensíveis",
      schema: { type: "string", enum: ["no-store"] },
    },
    Pragma: {
      description: "Compatibilidade defensiva para caches HTTP legados",
      schema: { type: "string", enum: ["no-cache"] },
    },
    XRequestId: {
      description: "Identificador de correlação da requisição",
      schema: { type: "string", format: "uuid" },
    },
    SetCookie: {
      description:
        "Cookies refresh HttpOnly e CSRF assinados; Secure em produção, SameSite=Strict e Path=/.",
      schema: { type: "array", items: { type: "string" } },
    },
  };
  components.parameters = {
    ...((components.parameters ?? {}) as JsonObject),
    ConsoleOrigin: {
      name: "Origin",
      in: "header",
      required: true,
      description: "Origem HTTPS exata permitida para a Console JRC.",
      schema: { type: "string", format: "uri" },
    },
  };

  const paths = (document.paths ?? {}) as Record<
    string,
    Record<string, JsonObject>
  >;
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      if (PROTECTED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
        operation.security = [{ bearerAuth: [] }, { jrcApiKeyAuth: [] }];
      }
      if (path.startsWith("/v1/messaging/"))
        operation.security = [{ bearerAuth: [] }];
      if (path.startsWith('/v1/flows'))
        operation.security = path.endsWith('/events') ? [{ chatwootSignature: [] }] : [{ bearerAuth: [] }];
      if (path.startsWith("/v1/integrations/"))
        operation.security = path.endsWith("/events")
            ? [{ chatwootSignature: [] }]
            : [{ bearerAuth: [] }];
      if (path.startsWith('/v1/integrations/chatwoot/control/'))
        operation.security = [{ bearerAuth: [] }, { jrcApiKeyAuth: [] }];
      if (
        path.startsWith("/v1/meta-onboarding") ||
        path === "/v1/organization/operations"
      )
        operation.security = [{ bearerAuth: [] }];
      if (path.startsWith("/v1/platform/"))
        operation.security = path.endsWith("/auth/login")
          ? []
          : method === "get"
            ? [{ platformSession: [] }]
            : [{ platformSession: [], platformCsrf: [] }];
      if (path === "/v1/webhooks/meta") {
        operation.security = method === "post" ? [{ metaSignature: [] }] : [];
        operation.description =
          method === "post"
            ? "Recebe eventos Meta assinados. Confirma após persistência durável de textos, referências privadas de anexos e estados de entrega."
            : "Verifica hub.mode=subscribe e hub.verify_token; retorna hub.challenge como texto.";
        if (method === "get")
          operation.parameters = [
            "hub.mode",
            "hub.verify_token",
            "hub.challenge",
          ].map((name) => ({
            name,
            in: "query",
            required: true,
            schema: { type: "string" },
          }));
        else
          operation.requestBody = {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["object", "entry"],
                  properties: {
                    object: {
                      type: "string",
                      enum: ["whatsapp_business_account"],
                    },
                    entry: {
                      type: "array",
                      items: { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
          };
        operation.responses =
          method === "get"
            ? {
                "200": {
                  description: "Desafio verificado",
                  content: { "text/plain": { schema: { type: "string" } } },
                },
                "403": { description: "Verificação recusada" },
              }
            : Object.fromEntries(
                [200, 400, 401, 413, 415, 503].map((status) => [
                  String(status),
                  {
                    description:
                      status === 200
                        ? "Evento persistido"
                        : "Evento recusado ou persistência indisponível",
                    content: {
                      "application/json": { schema: { type: "object" } },
                    },
                  },
                ]),
              );
      }
      if (path.startsWith(CONSOLE_AUTH_PATH_PREFIX)) {
        const parameters = (operation.parameters ?? []) as Array<JsonObject>;
        operation.parameters = [
          ...parameters,
          { $ref: "#/components/parameters/ConsoleOrigin" },
        ];
      }
      const responses = (operation.responses ?? {}) as Record<
        string,
        JsonObject
      >;
      for (const [status, response] of Object.entries(responses)) {
        response.headers = {
          ...((response.headers ?? {}) as JsonObject),
          "Cache-Control": { $ref: "#/components/headers/CacheControl" },
          Pragma: { $ref: "#/components/headers/Pragma" },
          "X-Request-Id": { $ref: "#/components/headers/XRequestId" },
          ...(path.startsWith(CONSOLE_AUTH_PATH_PREFIX)
            ? { "Set-Cookie": { $ref: "#/components/headers/SetCookie" } }
            : {}),
        };
        if (Number(status) >= 400 && path !== "/v1/webhooks/meta") {
          const content = (response.content ?? {}) as JsonObject;
          const json = content["application/json"];
          response.content = {
            "application/problem+json": json ?? {
              schema: { $ref: "#/components/schemas/ProblemDetails" },
            },
          };
        }
      }
    }
  }
  return document;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

export async function createOpenApiDocument(): Promise<JsonObject> {
  const app = buildApp(documentationOptions());
  try {
    await app.ready();
    return sortJson(
      normalizeDocument(app.swagger() as JsonObject),
    ) as JsonObject;
  } finally {
    await app.close();
  }
}

export function serializeOpenApiDocument(document: JsonObject): string {
  return `${JSON.stringify(sortJson(document), null, 2)}\n`;
}

async function generate(): Promise<void> {
  const outputPath = resolve("docs/api/openapi.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    serializeOpenApiDocument(await createOpenApiDocument()),
    "utf8",
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await generate();
}

export const openApiModulePath = fileURLToPath(import.meta.url);
