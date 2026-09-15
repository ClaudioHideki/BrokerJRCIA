import { tenantOperationalProblem } from "../../modules/tenancy/operational-limits.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  MessagingChannelsResponseSchema,
  TemplatesResponseSchema,
  ConversationsResponseSchema,
  MessagesResponseSchema,
  SendTemplateRequestSchema,
  ConversationModeRequestSchema,
  ConfigureBotRequestSchema,
  MessagingChannelViewSchema,
  MessageViewSchema,
  ConversationViewSchema,
  PROBLEM_CONTENT_TYPE,
  type ConfigureBotRequest,
  type MessagingChannelView,
  type TemplateView,
  type ConversationView,
  type MessageView,
  type SendTemplateRequest,
} from "@jrc/contracts";
import {
  authenticateRequest,
  type AuthenticationOptions,
} from "../plugins/authentication.js";
import type { Role } from "../plugins/authorization.js";
import { SendTextRequestSchema, type SendTextRequest } from "@jrc/contracts";
import { MediaError, safeMediaName, type BinaryMedia } from "@jrc/providers";

export interface MessagingService {
  retryMessage?(
    organizationId: string,
    id: string,
    reason: string,
    actorId?: string,
  ): Promise<MessageView>;
  sendText?(
    organizationId: string,
    channelId: string,
    input: SendTextRequest,
    idempotencyKey: string,
  ): Promise<MessageView>;
  readMedia?(organizationId: string, id: string): Promise<BinaryMedia>;
  listChannels(
    organizationId: string,
  ): Promise<{ data: MessagingChannelView[] }>;
  listTemplates(
    organizationId: string,
    channelId: string,
  ): Promise<{ data: TemplateView[] }>;
  listConversations(
    organizationId: string,
    channelId: string,
  ): Promise<{ data: ConversationView[] }>;
  listMessages(
    organizationId: string,
    conversationId: string,
  ): Promise<{ data: MessageView[] }>;
  sendTemplate(
    organizationId: string,
    channelId: string,
    input: SendTemplateRequest,
    idempotencyKey: string,
  ): Promise<MessageView>;
  configureBot(
    organizationId: string,
    channelId: string,
    input: ConfigureBotRequest,
  ): Promise<MessagingChannelView>;
  setMode(
    organizationId: string,
    conversationId: string,
    mode: "BOT" | "HUMAN",
  ): Promise<ConversationView>;
}
export interface MessagingRouteOptions extends AuthenticationOptions {
  service: MessagingService;
  resolveCurrentRole(
    userId: string,
    organizationId: string,
  ): Promise<Role | null>;
}
const idParams = z.strictObject({ id: z.uuid() });
const emptyQuery = z.strictObject({});
function tenant(request: FastifyRequest) {
  return request.authentication!.organizationId;
}
function permission(write: boolean) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const context = request.authentication;
    // Existing instance API keys do not implicitly gain messaging privileges.
    if (context?.kind === "JWT" && (!write || context.role !== "VIEWER"))
      return;
    return reply
      .code(403)
      .type(PROBLEM_CONTENT_TYPE)
      .send({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        code: "FORBIDDEN",
        requestId: request.id,
      });
  };
}
async function automationAdministrator(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const context = request.authentication;
  if (
    context?.kind === "JWT" &&
    (context.role === "OWNER" || context.role === "ADMIN")
  )
    return;
  return reply
    .code(403)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
      requestId: request.id,
    });
}
export async function registerMessagingRoutes(
  app: FastifyInstance,
  options: MessagingRouteOptions,
) {
  app.decorateRequest("authentication", null);
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MediaError) {
      const status =
        error.code === "MEDIA_NOT_FOUND" ? 404 : error.retrySafe ? 409 : 422;
      return reply
        .code(status)
        .type(PROBLEM_CONTENT_TYPE)
        .send({
          type: "about:blank",
          title: "Media unavailable",
          status,
          code: error.code,
          requestId: request.id,
        });
    }
    const tenantProblem = tenantOperationalProblem(error, request.id);
    if (tenantProblem)
      return reply
        .code(tenantProblem.status)
        .type(PROBLEM_CONTENT_TYPE)
        .send(tenantProblem);
    const candidate = error as {
      status?: number;
      statusCode?: number;
      validation?: unknown;
      code?: unknown;
    };
    const status = candidate.validation
      ? 400
      : typeof candidate.statusCode === "number" &&
          candidate.statusCode >= 400 &&
          candidate.statusCode < 500
        ? candidate.statusCode
        : [404, 409, 422, 503].includes(candidate.status ?? 0)
          ? candidate.status!
          : 500;
    const code =
      status === 400
        ? "INVALID_REQUEST"
        : status === 404
          ? "NOT_FOUND"
          : status === 500
            ? "INTERNAL_ERROR"
            : "MESSAGING_UNAVAILABLE";
    // Never log provider bodies or credential references.
    return reply
      .code(status)
      .type(PROBLEM_CONTENT_TYPE)
      .send({
        type: "about:blank",
        title: "Messaging request failed",
        status,
        code,
        requestId: request.id,
      });
  });
  const api = app.withTypeProvider<ZodTypeProvider>();
  const currentMembership = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const context = request.authentication;
    if (context?.kind !== "JWT") return;
    const role = await options.resolveCurrentRole(
      context.actorId,
      context.organizationId,
    );
    if (!role)
      return reply
        .code(403)
        .type(PROBLEM_CONTENT_TYPE)
        .send({
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          code: "FORBIDDEN",
          requestId: request.id,
        });
    request.authentication = { ...context, role };
  };
  const read = [
    authenticateRequest(options),
    currentMembership,
    permission(false),
  ];
  const write = [
    authenticateRequest(options),
    currentMembership,
    permission(true),
  ];
  const administerAutomation = [
    authenticateRequest(options),
    currentMembership,
    automationAdministrator,
  ];
  api.post(
    "/v1/messaging/messages/:id/retry",
    {
      preHandler: administerAutomation,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        body: z.strictObject({ reason: z.string().trim().min(5).max(500) }),
        response: { 200: MessageViewSchema },
      },
    },
    (request) => {
      if (!options.service.retryMessage)
        throw Object.assign(new Error("MESSAGING_UNAVAILABLE"), {
          status: 503,
        });
      return options.service.retryMessage(
        tenant(request),
        request.params.id,
        request.body.reason,
        request.authentication?.actorId ?? undefined,
      );
    },
  );
  api.get(
    "/v1/messaging/media/:id",
    { preHandler: read, schema: { params: idParams, querystring: emptyQuery } },
    async (request, reply) => {
      if (!options.service.readMedia)
        throw new MediaError("MEDIA_NOT_CONFIGURED");
      const file = await options.service.readMedia(
        tenant(request),
        request.params.id,
      );
      return reply
        .type(file.mimeType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(safeMediaName(file.fileName))}`,
        )
        .send(Buffer.from(file.bytes));
    },
  );
  api.post(
    "/v1/messaging/channels/:id/text",
    {
      preHandler: write,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        body: SendTextRequestSchema,
        headers: z.object({
          "idempotency-key": z
            .string()
            .min(8)
            .max(128)
            .regex(/^[a-zA-Z0-9_-]+$/),
        }),
        response: { 202: MessageViewSchema },
      },
    },
    async (request, reply) => {
      if (!options.service.sendText)
        throw Object.assign(new Error("MESSAGING_UNAVAILABLE"), {
          status: 503,
        });
      return reply
        .code(202)
        .send(
          await options.service.sendText(
            tenant(request),
            request.params.id,
            request.body,
            request.headers["idempotency-key"],
          ),
        );
    },
  );
  api.get(
    "/v1/messaging/channels",
    {
      preHandler: read,
      schema: {
        querystring: emptyQuery,
        response: { 200: MessagingChannelsResponseSchema },
      },
    },
    (request) => options.service.listChannels(tenant(request)),
  );
  api.get(
    "/v1/messaging/channels/:id/templates",
    {
      preHandler: read,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        response: { 200: TemplatesResponseSchema },
      },
    },
    (request) =>
      options.service.listTemplates(tenant(request), request.params.id),
  );
  api.get(
    "/v1/messaging/channels/:id/conversations",
    {
      preHandler: read,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        response: { 200: ConversationsResponseSchema },
      },
    },
    (request) =>
      options.service.listConversations(tenant(request), request.params.id),
  );
  api.get(
    "/v1/messaging/conversations/:id/messages",
    {
      preHandler: read,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        response: { 200: MessagesResponseSchema },
      },
    },
    (request) =>
      options.service.listMessages(tenant(request), request.params.id),
  );
  api.post(
    "/v1/messaging/channels/:id/messages",
    {
      preHandler: write,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        body: SendTemplateRequestSchema,
        headers: z.object({
          "idempotency-key": z
            .string()
            .min(8)
            .max(128)
            .regex(/^[a-zA-Z0-9_-]+$/),
        }),
        response: { 202: MessageViewSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await options.service.sendTemplate(
            tenant(request),
            request.params.id,
            request.body,
            request.headers["idempotency-key"],
          ),
        ),
  );
  api.patch(
    "/v1/messaging/channels/:id/automation",
    {
      preHandler: administerAutomation,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        body: ConfigureBotRequestSchema,
        response: { 200: MessagingChannelViewSchema },
      },
    },
    (request) =>
      options.service.configureBot(
        tenant(request),
        request.params.id,
        request.body,
      ),
  );
  api.patch(
    "/v1/messaging/conversations/:id/mode",
    {
      preHandler: write,
      schema: {
        params: idParams,
        querystring: emptyQuery,
        body: ConversationModeRequestSchema,
        response: { 200: ConversationViewSchema },
      },
    },
    (request) =>
      options.service.setMode(
        tenant(request),
        request.params.id,
        request.body.mode,
      ),
  );
}
