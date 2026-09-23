import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  BindChatwootAccountSchema,
  ChatwootStatusSchema,
  ConnectChatwootSchema,
  IntegrationJobsSchema,
  ReconcileIntegrationJobSchema,
  MessagingChannelViewSchema,
  PROBLEM_CONTENT_TYPE,
  DestinationRequestSchema,
  ChatwootDestinationSchema,
} from "@jrc/contracts";
import { ChatwootDestinationError } from '../../modules/integrations/chatwoot-destination.js';
import {
  authenticateRequest,
  type AuthenticationOptions,
} from "../plugins/authentication.js";
import type { Role } from "../plugins/authorization.js";
import { ChatwootError } from "../../modules/integrations/chatwoot-client.js";
import {
  IntegrationError,
  type ChatwootService,
} from "../../modules/integrations/chatwoot-service.js";
import { tenantOperationalProblem } from "../../modules/tenancy/operational-limits.js";
import type { createQrMessagingService } from "../../modules/messaging/qr-service.js";

export interface IntegrationRouteOptions extends AuthenticationOptions {
  service?: ChatwootService | undefined;
  qr?: ReturnType<typeof createQrMessagingService> | undefined;
  resolveCurrentRole(userId: string, org: string): Promise<Role | null>;
}
const params = z.strictObject({ id: z.uuid() }),
  empty = z.strictObject({});
const org = (request: FastifyRequest) => request.authentication!.organizationId;
const actor = (request: FastifyRequest) =>
  request.authentication!.actorId ?? undefined;
export async function registerIntegrationRoutes(
  app: FastifyInstance,
  options: IntegrationRouteOptions,
): Promise<void> {
  app.decorateRequest("authentication", null);
  app.setErrorHandler((error, request, reply) => {
    const operational = tenantOperationalProblem(error, request.id);
    if (operational)
      return reply
        .code(operational.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(operational);
    const candidate = error as {
      validation?: unknown;
      code?: string;
      status?: number;
      statusCode?: number;
    };
    const status =
      error instanceof IntegrationError || error instanceof ChatwootDestinationError
        ? error.status
        : candidate.validation || error instanceof z.ZodError
          ? 400
          : candidate.code === "23505"
            ? 409
            : error instanceof ChatwootError
              ? 502
              : [400, 401, 403, 413, 415].includes(
                    candidate.statusCode ?? candidate.status ?? 0,
                  )
                ? (candidate.statusCode ?? candidate.status)!
                : 503;
    const code =
      error instanceof IntegrationError || error instanceof ChatwootError || error instanceof ChatwootDestinationError
        ? error.code
        : candidate.code === "23505"
          ? "INTEGRATION_ALREADY_BOUND"
          : status === 400
            ? "INVALID_REQUEST"
            : status === 401
              ? "INVALID_WEBHOOK_SIGNATURE"
              : "INTEGRATION_UNAVAILABLE";
    return reply.code(status).type(PROBLEM_CONTENT_TYPE).send({
      type: "about:blank",
      title: code,
      status,
      code,
      requestId: request.id,
    });
  });
  const service = () => {
    if (!options.service)
      throw new IntegrationError("CHATWOOT_NOT_CONFIGURED", 503);
    return options.service;
  };
  const guard =
    (write: boolean) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const a = request.authentication;
      const role =
        a?.kind === "JWT"
          ? await options.resolveCurrentRole(a.actorId, a.organizationId)
          : null;
      if (!role || (write && !["OWNER", "ADMIN"].includes(role)))
        return reply.code(403).type(PROBLEM_CONTENT_TYPE).send({
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          code: "FORBIDDEN",
          requestId: request.id,
        });
    };
  const read = [authenticateRequest(options), guard(false)],
    write = [authenticateRequest(options), guard(true)];
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get('/v1/integrations/chatwoot/destination', {
    preHandler: read, schema: { querystring: empty, response: { 200: ChatwootDestinationSchema.nullable() } },
  }, async request => (await service().destinations.get(org(request))) ?? null);
  api.put('/v1/integrations/chatwoot/destination', {
    preHandler: write, schema: { querystring: empty, body: DestinationRequestSchema, response: { 200: ChatwootDestinationSchema } },
  }, request => service().destinations.request(org(request), request.body));
  api.post(
    "/v1/integrations/chatwoot/connections/:id/retry",
    {
      preHandler: write,
      schema: {
        params,
        querystring: empty,
        body: z.strictObject({
          replaceExistingWebhook: z.boolean().default(false),
        }),
        response: { 200: ChatwootStatusSchema },
      },
    },
    (request) =>
      service().retryConnection(
        org(request),
        request.params.id,
        request.body.replaceExistingWebhook,
        actor(request),
      ),
  );
  api.post(
    "/v1/integrations/chatwoot/jobs/:id/reconcile",
    {
      preHandler: write,
      schema: {
        params,
        querystring: empty,
        body: ReconcileIntegrationJobSchema,
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    (request) =>
      service().reconcileJob(
        org(request),
        request.params.id,
        request.body.reason,
        request.body.remoteId,
        actor(request),
      ),
  );
  api.get(
    "/v1/integrations/chatwoot/sources",
    { preHandler: write, schema: { querystring: empty } },
    (request) => service().sources(org(request)),
  );
  api.get(
    "/v1/integrations/chatwoot",
    {
      preHandler: read,
      schema: { querystring: empty, response: { 200: ChatwootStatusSchema } },
    },
    (request) =>
      options.service
        ? options.service.status(org(request))
        : {
            configured: false,
            baseUrl: null,
            provisioningAvailable: false,
            account: null,
            connections: [],
            jobs: {},
          },
  );
  api.put(
    "/v1/integrations/chatwoot/account",
    {
      preHandler: write,
      schema: {
        querystring: empty,
        body: BindChatwootAccountSchema,
        response: { 200: ChatwootStatusSchema },
      },
    },
    (request) =>
      service().bindAccount(org(request), request.body, actor(request)),
  );
  api.get(
    "/v1/integrations/chatwoot/inboxes",
    {
      preHandler: write,
      schema: {
        querystring: empty,
        response: {
          200: z.object({
            data: z.array(
              z.object({
                id: z.number().int(),
                name: z.string(),
                hasWebhook: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    (request) => service().inboxes(org(request)),
  );
  api.post(
    "/v1/integrations/chatwoot/connections",
    {
      preHandler: write,
      schema: {
        querystring: empty,
        body: ConnectChatwootSchema,
        response: { 200: ChatwootStatusSchema },
      },
    },
    (request) => service().connect(org(request), request.body, actor(request)),
  );
  api.get(
    "/v1/integrations/chatwoot/connections/:id/agents",
    { preHandler: write, schema: { params, querystring: empty } },
    (request) => service().agents(org(request), request.params.id),
  );
  api.post(
    "/v1/integrations/chatwoot/connections/:id/agents",
    {
      preHandler: write,
      schema: {
        params,
        querystring: empty,
        body: z.strictObject({
          userIds: z.array(z.number().int().positive()).min(1).max(100),
        }),
      },
    },
    (request) =>
      service().addAgents(
        org(request),
        request.params.id,
        request.body.userIds,
        actor(request),
      ),
  );
  api.post(
    "/v1/integrations/chatwoot/connections/:id/reconcile",
    {
      preHandler: write,
      schema: {
        params,
        querystring: empty,
        body: empty,
        response: { 200: ChatwootStatusSchema },
      },
    },
    (request) => service().reconcileConnection(org(request), request.params.id),
  );
  api.delete('/v1/integrations/chatwoot/connections/:id',{preHandler:write,schema:{params,querystring:empty}},request=>service().removeUnusedConnection(org(request),request.params.id,actor(request)));
  api.patch(
    "/v1/integrations/chatwoot/connections/:id",
    {
      preHandler: write,
      schema: {
        params,
        querystring: empty,
        body: z.strictObject({ enabled: z.boolean() }),
        response: { 200: ChatwootStatusSchema },
      },
    },
    (request) =>
      service().setEnabled(
        org(request),
        request.params.id,
        request.body.enabled,
        actor(request),
      ),
  );
  api.get(
    "/v1/integrations/chatwoot/jobs",
    {
      preHandler: read,
      schema: { querystring: empty, response: { 200: IntegrationJobsSchema } },
    },
    (request) => service().jobs(org(request)),
  );
  api.post(
    "/v1/integrations/chatwoot/jobs/:id/retry",
    {
      preHandler: write,
      schema: {
        params,
        querystring: empty,
        body: z.strictObject({ reason: z.string().trim().min(5).max(500) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    (request) =>
      service().retryJob(
        org(request),
        request.params.id,
        request.body.reason,
        actor(request),
      ),
  );
  api.post(
    "/v1/messaging/instances/:id/activate",
    {
      preHandler: write,
      schema: {
        params,
        querystring: empty,
        body: empty,
        response: { 200: MessagingChannelViewSchema },
      },
    },
    (request) => {
      if (!options.qr) throw new IntegrationError("QR_NOT_CONFIGURED", 503);
      return options.qr.activate(org(request), request.params.id);
    },
  );
  if (options.qr)
    api.post(
      "/v1/webhooks/whatsapp/:id",
      { bodyLimit: 1_048_576, schema: { params, querystring: empty } },
      async (request, reply) => {
        await options.qr!.ingest(
          request.params.id,
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          request.body,
        );
        return reply.code(200).send({ status: "accepted" });
      },
    );
  if (options.service)
    await app.register(async (scope) => {
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "buffer", bodyLimit: 1_048_576 },
        (_request, body, done) => done(null, body),
      );
      scope.post<{ Params: { id: string }; Body: Buffer }>(
        "/v1/integrations/chatwoot/:id/events",
        async (request, reply) => {
          const id = z.uuid().parse(request.params.id);
          if (!Buffer.isBuffer(request.body))
            throw new IntegrationError("INVALID_WEBHOOK_PAYLOAD", 400);
          const timestamp = request.headers["x-chatwoot-timestamp"],
            signature = request.headers["x-chatwoot-signature"];
          await options.service!.ingest(
            id,
            request.body,
            typeof timestamp === "string" ? timestamp : undefined,
            typeof signature === "string" ? signature : undefined,
          );
          return reply.code(200).send({ status: "accepted" });
        },
      );
    });
}
