import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { z } from 'zod';
import { AutomationMediaAssetSchema } from '@jrc/contracts';
import { SUPPORTED_UPLOAD_MIME_TYPES } from '@jrc/providers';

import type { InstanceService } from "../modules/instances/service.js";
import type { ProviderAccountService } from "../modules/provider-accounts/service.js";
import type { MessagingService } from "./routes/messaging.js";
import { buildApp } from "../app.js";

type JsonObject = Record<string, unknown>;

const DOCUMENTATION_SECRET = "documentation-secret-with-at-least-32-bytes";
const PROTECTED_PATH_PREFIXES = [
  "/v1/api-keys",
  "/v1/automations",
  "/v1/attendance",
  "/v1/automation-nodes",
  "/v1/automation-imports",
  "/v1/credentials",
  "/v1/webhooks",
  "/v1/channels",
  "/v1/executions",
  "/v1/operations",
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
    partnerWebhooks: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable,
      service: new Proxy({}, {get() { return unavailable; }}) as import('../modules/partner-events/service.js').PartnerEventService,
    },
    support: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, {get(){return unavailable;}}) as import('../modules/support/service.js').SupportService,
    },
    channels: {
      lifecycle: new Proxy({}, {get(){return unavailable;}}) as import('../modules/lifecycle/service.js').LifecycleService,
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`,
      authenticateApiKey: unavailable,
      resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as import('../modules/channels/facade.js').ChannelFacade,
    },
    flows: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as ReturnType<typeof import('../modules/flows/service.js').createFlowService>,
      chatwoot: new Proxy({}, { get() { return unavailable; } }) as ReturnType<typeof import('../modules/flows/chatwoot-service.js').createFlowChatwootService>,
    },
    flowDelegation:{authenticateApiKey:unavailable,jwtSecret:DOCUMENTATION_SECRET,resolveCurrentRole:unavailable,resolveFlowSession:unavailable,service:new Proxy({},{get(){return unavailable;}}) as ReturnType<typeof import('../modules/flows/delegation/service.js').createFlowDelegationService>},
    nativeFlow:{reopenProof:new Proxy({},{get(){return unavailable;}}) as ReturnType<typeof import('../modules/flows/delegation/broker-reopen-proof.js').createNativeReopenProof>,authenticateApiKey:unavailable,jwtSecret:DOCUMENTATION_SECRET,resolveCurrentRole:unavailable,resolveFlowCredential:unavailable,resolveInstallationGrant:unavailable,resolveInstallationReduction:unavailable,registration:new Proxy({},{get(){return unavailable;}}) as ReturnType<typeof import('../modules/flows/delegation/registration/service.js').createNativeRegistrationService>,installation:new Proxy({},{get(){return unavailable;}}) as ReturnType<typeof import('../modules/flows/delegation/installation/service.js').createNativeInstallationService>,service:new Proxy({},{get(){return unavailable;}}) as ReturnType<typeof import('../modules/flows/delegation/service.js').createFlowDelegationService>,rateLimit:{store:{kind:'memory' as const,consume:unavailable},secret:DOCUMENTATION_SECRET,nodeEnv:'test' as const,trustedProxyCidrs:[],ipLimit:1,identityLimit:1,windowMs:60000}},
    automations: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as import('../modules/automations/service.js').AutomationService,
      executions: new Proxy({}, { get() { return unavailable; } }) as ReturnType<typeof import('../modules/automations/service.js').createExecutionService>,
      migration: new Proxy({}, { get() { return unavailable; } }) as import('../modules/automations/legacy-migration.js').LegacyFlowMigrationService,
    },
    attendanceResume: {
      jwtSecret:`${DOCUMENTATION_SECRET}-jwt`,authenticateApiKey:unavailable,resolveCurrentRole:unavailable,
      service:new Proxy({}, {get(){return unavailable;}}) as ReturnType<typeof import('../modules/attendance/resume-service.js').createAttendanceResumeService>,
    },
    attendanceLocal: {
      jwtSecret:`${DOCUMENTATION_SECRET}-jwt`,authenticateApiKey:unavailable,resolveCurrentRole:unavailable,
      service:new Proxy({}, {get(){return unavailable;}}) as ReturnType<typeof import('../modules/attendance/local-catalog.js').createLocalAttendanceCatalog>,
      directory:new Proxy({}, {get(){return unavailable;}}) as ReturnType<typeof import('../modules/attendance/local-directory-service.js').createLocalAttendanceDirectoryService>,
    },
    observability: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as import('../modules/observability/service.js').ObservabilityService,
    },
    credentials: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as import('../modules/automation-integrations/credentials.js').CredentialService,
    },
    automationWebhooks: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as ReturnType<typeof import('../modules/automation-integrations/webhooks.js').createWebhookService>,
    },
    automationImports: {
      jwtSecret: `${DOCUMENTATION_SECRET}-jwt`, authenticateApiKey: unavailable, resolveCurrentRole: unavailable,
      service: new Proxy({}, { get() { return unavailable; } }) as import('../modules/automation-integrations/importer.js').AutomationImporter,
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
      lifecycle: new Proxy({}, {get(){return unavailable;}}) as import('../modules/lifecycle/service.js').LifecycleService,
      support: new Proxy({}, {get(){return unavailable;}}) as import('../modules/support/service.js').SupportService,
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
    whatsappGroups: {
      jwtSecret:`${DOCUMENTATION_SECRET}-jwt`,authenticateApiKey:unavailable,resolveCurrentRole:unavailable,
      service:new Proxy({}, {get(){return unavailable;}}) as ReturnType<typeof import('../modules/whatsapp-groups/service.js').createWhatsAppGroupCatalog>,
      configuration:new Proxy({}, {get(){return unavailable;}}) as ReturnType<typeof import('../modules/whatsapp-groups/webhook-configuration.js').createWhatsAppGroupWebhookConfiguration>,
      automation:new Proxy({}, {get(){return unavailable;}}) as ReturnType<typeof import('../modules/whatsapp-groups/automation-runtime.js').createGroupAutomationRuntime>,
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
    flowSessionAuth:{type:'http',scheme:'bearer',description:'Scoped opaque Flow session; tenant derives from jrc_auth.'},
    flowCredentialAuth:{type:'http',scheme:'bearer',description:'Dedicated opaque native credential; not a session, JWT or grant.'},
    flowInstallationGrantAuth:{type:'http',scheme:'bearer',description:'Installation grant authority only; reduction replay is exact bounded receipt only.'},
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
      if (path.startsWith('/v1/messaging/') && method === 'get')
        operation.security = [{ bearerAuth: [] }, { jrcApiKeyAuth: [] }];
      if (['/v1/messaging/channels/{id}/partner-text','/v1/messaging/instances/{id}/partner-activate','/v1/integrations/chatwoot/control/connections/{integrationId}/campaign-intents'].includes(path) && method === 'post')
        operation.security = [{ jrcApiKeyAuth: [] }];
      if (path === '/v1/messaging/media/{id}' && method === 'get') {
        operation.responses = { ...((operation.responses ?? {}) as JsonObject),
          '200': {description:'Bytes privados do anexo; MIME depende do arquivo. Não retorna JSON.',content:{'application/octet-stream':{schema:{type:'string',format:'binary'}}}} };
      }
      if (['/v1/partner-webhooks', '/v1/partner-events', '/v1/partner-webhook-deliveries'].some(prefix => path === prefix || path.startsWith(prefix + '/')))
        operation.security = [{ bearerAuth: [] }, { jrcApiKeyAuth: [] }];
      if(path.startsWith('/v1/delegated-flows'))operation.security=[{flowSessionAuth:[]}];
      if (method === 'post' && /^\/v1\/(?:automations|delegated-flows)\/\{id\}\/channels\/\{channelId\}\/media$/.test(path)) {
        operation.description = 'Arquivo privado binário de 1 a 16 MiB, sujeito ao limite por MIME e à quota. Não é um grafo JSON nem uma URL pública. A mesma chave exige os mesmos bytes, raiz e caixa; autorização é revalidada durante o armazenamento.';
        operation.parameters = [
          ...['id', 'channelId'].map(name => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } })),
          { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'X-JRC-Media-Mime', in: 'header', required: true, schema: { type: 'string', enum: [...SUPPORTED_UPLOAD_MIME_TYPES] } },
          { name: 'X-JRC-Media-Kind', in: 'header', required: true, schema: { type: 'string', enum: ['image', 'audio', 'video', 'document'] } },
          { name: 'X-JRC-Media-Name', in: 'header', required: true, description: 'Nome codificado com encodeURIComponent.', schema: { type: 'string', minLength: 1, maxLength: 765 } },
        ];
        operation.requestBody = { required: true, content: { 'application/octet-stream': {
          schema: { type: 'string', format: 'binary', minLength: 1, maxLength: 16 * 1024 * 1024 },
        } } };
        operation.responses = {
          '201': { description: 'Metadados do arquivo privado na raiz e caixa autorizadas.', content: {
            'application/json': { schema: z.toJSONSchema(AutomationMediaAssetSchema, { target: 'openapi-3.0' }) },
          } },
          ...Object.fromEntries([400, 401, 403, 409, 413, 422, 500, 503].map(status => [String(status), { description: 'Upload recusado ou armazenamento indisponível.' }])),
        };
      }
      if(path.startsWith('/v1/flow-delegations'))operation.security=[{bearerAuth:[]}];
      if((path.startsWith('/v1/flow-delegations/native-sessions')||path.startsWith('/v1/flow-delegations/native-cutovers/'))||path==='/v1/flow-delegations/native-context'||method==='get'&&path==='/v1/flow-delegations/native-registration-challenges/{id}'||method==='post'&&path==='/v1/flow-delegations/native-registrations'||path.endsWith('/claim'))operation.security=[{flowCredentialAuth:[]}];
      if(path.startsWith('/v1/flow-delegations/native-installations/'))operation.security=[{flowInstallationGrantAuth:[]}];
      if (path.startsWith('/v1/attendance/'))operation.security=[{bearerAuth:[]}];
      if (['/v1/channels', '/v1/credentials', '/v1/automations', '/v1/automation-nodes', '/v1/automation-imports', '/v1/executions', '/v1/operations', '/v1/webhooks', '/v1/support']
        .some(prefix => path === prefix || path.startsWith(`${prefix}/`)))
        operation.security = [{ bearerAuth: [] }];
      if (path.startsWith('/v1/automations/migrations/legacy')) {
        operation.security = [{ bearerAuth: [] }];
        operation.description = method === 'get'
          ? 'Lista o estado da reconciliação legada somente para a organização autenticada.'
          : 'Executa uma transição auditada para a organização autenticada. Requer papel OWNER ou ADMIN e Idempotency-Key.';
        const migrationResponses = (operation.responses ?? {}) as Record<string, JsonObject>;
        migrationResponses['400'] ??= { description: 'Requisição ou Idempotency-Key inválida' };
        migrationResponses['403'] ??= { description: 'Papel da organização sem permissão' };
        if (method === 'post') migrationResponses['409'] ??= { description: 'Conflito, execução viva ou transição insegura' };
        operation.responses = migrationResponses;
      }
      if (path.startsWith('/v1/flows'))
        operation.security = path.endsWith('/events') ? [{ chatwootSignature: [] }] : [{ bearerAuth: [] }];
      if (path.startsWith("/v1/integrations/"))
        operation.security = path.endsWith("/events")
            ? [{ chatwootSignature: [] }]
            : [{ bearerAuth: [] }];
      if (path.startsWith('/v1/integrations/chatwoot/control/')) {
        operation.security = [{ bearerAuth: [] }, { jrcApiKeyAuth: [] }];
        // Documentation of the existing control error handler, not new runtime behavior.
        const errors: Record<string, string> = {
          '400': 'INVALID_REQUEST: parâmetros, corpo ou chave idempotente inválidos.',
          '401': 'INVALID_CREDENTIALS: informe uma única credencial válida.',
          '403': 'CHATWOOT_CONTROL_FORBIDDEN: escopo, vínculo ou papel atual insuficiente.',
          '404': 'Controle desligado ou recurso indisponível no tenant autenticado.',
          '409': 'Conflito de revisão, identidade, contexto ou operação; consultar e conciliar antes de repetir.',
          '413': 'Corpo excede o limite da API.', '415': 'Tipo de conteúdo não aceito.',
          '502': 'O provedor ou a central remota recusou a operação ou está indisponível.',
          '503': 'Controle ou dependência indisponível; resultado de mutação pode exigir conciliação.',
        };
        const responses = (operation.responses ?? {}) as Record<string, JsonObject>;
        for (const [status, description] of Object.entries(errors)) responses[status] ??= { description };
        operation.responses = responses;
        if (method !== 'get') {
          const parameters = (operation.parameters ?? []) as JsonObject[];
          if (!parameters.some(p => String(p.name).toLowerCase() === 'x-jrc-external-actor')) {
            operation.parameters = [...parameters, { name: 'X-JRC-External-Actor', in: 'header', required: false,
              description: 'Atribuição auditável opcional para chave de controle. Não autentica nem autoriza o usuário remoto. Campanhas exigem o ID numérico do administrador.',
              schema: { type: 'string', pattern: '^[A-Za-z0-9:_-]{1,80}$' } }];
          }
        }
      }
      if (method === 'post' && path === '/v1/integrations/chatwoot/control/connections/{integrationId}/campaign-intents')
        operation.security = [{ jrcApiKeyAuth: [] }];
      if (path.startsWith('/v1/integrations/chatwoot/control/connections/{integrationId}/conversations/{remoteConversationId}/'))
        operation.security = [{ jrcApiKeyAuth: [] }];
      if (
        path.startsWith("/v1/meta-onboarding") ||
        path.startsWith("/v1/organization/")
      )
        operation.security = [{ bearerAuth: [] }];
      if (path.startsWith("/v1/platform/"))
        operation.security = path.endsWith("/auth/login") || path.endsWith('/auth/config')
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
