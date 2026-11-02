import { AttendanceError } from '../../modules/attendance/types.js';
import { tenantOperationalProblem } from "../../modules/tenancy/operational-limits.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  MessagingChannelsResponseSchema,
  TemplatesResponseSchema,
  TemplateStatusResponseSchema,
  CreateTextTemplateRequestSchema,
  SubmittedTemplateSchema,
  ConversationsResponseSchema,
  MessagesResponseSchema,
  SendTemplateRequestSchema,
  IdempotencyHeadersSchema,
  ConversationModeRequestSchema,
  ConfigureBotRequestSchema,
  MessagingChannelViewSchema,
  MessageViewSchema,
  QrOutboundObservationViewSchema, QrOutboundObservationsResponseSchema, AbandonQrOutboundObservationRequestSchema,
  type QrOutboundObservationView, type AbandonQrOutboundObservationRequest,
  QrDispatchAttemptViewSchema,QrDispatchAttemptsResponseSchema,AbandonQrDispatchAttemptRequestSchema,type QrDispatchAttemptView,type AbandonQrDispatchAttemptRequest,
  ConversationViewSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  type ConfigureBotRequest,
  type MessagingChannelView,
  type TemplateView,
  type TemplateStatusResponse,
  type CreateTextTemplateRequest,
  type SubmittedTemplate,
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
import { PartnerTextRequestSchema, type PartnerTextRequest } from '@jrc/contracts';
import { PartnerMediaMetadataSchema, PartnerMediaRequestSchema, type PartnerMediaMetadata, type PartnerMediaRequest } from '@jrc/contracts';
import { MediaError, safeMediaName, SUPPORTED_UPLOAD_MIME_TYPES, type BinaryMedia } from "@jrc/providers";

export interface MessagingService {
  uploadPartnerMedia?(organizationId: string, channelId: string, input: BinaryMedia & {idempotencyKey:string}, apiKeyId: string): Promise<PartnerMediaMetadata>;
  getPartnerMedia?(organizationId: string, channelId: string, mediaId: string, apiKeyId: string): Promise<PartnerMediaMetadata>;
  sendPartnerMedia?(organizationId: string, channelId: string, input: PartnerMediaRequest, idempotencyKey: string, apiKeyId: string): Promise<MessageView & {conversationId:string}>;
  sendPartnerText?(organizationId: string, channelId: string, input: PartnerTextRequest,
    idempotencyKey: string, apiKeyId: string): Promise<MessageView & {conversationId:string}>;
  listQrOutboundObservations?(organizationId:string,conversationId:string):Promise<{data:QrOutboundObservationView[]}>;
  abandonQrOutboundObservation?(organizationId:string,id:string,input:AbandonQrOutboundObservationRequest,actorId:string):Promise<QrOutboundObservationView>;
  listQrDispatchAttempts?(organizationId:string,conversationId:string):Promise<{data:QrDispatchAttemptView[]}>;
  abandonQrDispatchAttempt?(organizationId:string,id:string,input:AbandonQrDispatchAttemptRequest,actorId:string):Promise<QrDispatchAttemptView>;
  getConversation?(organizationId: string, conversationId: string): Promise<ConversationView>;
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
  getTemplateStatus(
    organizationId: string,
    channelId: string,
    templateId: string,
  ): Promise<TemplateStatusResponse>;
  createTextTemplate(
    organizationId: string,
    channelId: string,
    input: CreateTextTemplateRequest,
    idempotencyKey: string,
  ): Promise<SubmittedTemplate>;
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
const templateStatusParams = z.strictObject({ id: z.uuid(), templateId: z.string().regex(/^[1-9]\d{4,63}$/) });
const emptyQuery = z.strictObject({});
function tenant(request: FastifyRequest) {
  return request.authentication!.organizationId;
}
function permission(write: boolean) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const context = request.authentication;
    if (!write && context?.kind === 'API_KEY' && context.scopes.includes('messaging:read')) return;
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
async function partnerSenderPermission(request: FastifyRequest, reply: FastifyReply) {
  const context = request.authentication;
  if (context?.kind === 'API_KEY' && context.scopes.includes('messaging:send')) return;
  return reply.code(403).type(PROBLEM_CONTENT_TYPE).send({type:'about:blank',title:'Forbidden',status:403,code:'FORBIDDEN',requestId:request.id});
}
function partnerMediaPermission(scopes: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const context = request.authentication;
    if (context?.kind === 'API_KEY' && scopes.every(scope => context.scopes.includes(scope))) return;
    return reply.code(403).type(PROBLEM_CONTENT_TYPE).send({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'FORBIDDEN', requestId: request.id });
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
    if(error instanceof AttendanceError)return reply.code(error.statusCode).type('application/problem+json').send({type:'about:blank',title:error.code,status:error.statusCode,code:error.code,requestId:request.id});
    if (error instanceof MediaError) {
      const status =
        error.code === "MEDIA_NOT_FOUND" ? 404 : error.code === 'MEDIA_SIZE_LIMIT' ? 413 : error.code === 'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT' || error.retrySafe ? 409 : 422;
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
    const status = candidate.validation || error instanceof z.ZodError
      ? 400
      : typeof candidate.statusCode === "number" &&
          candidate.statusCode >= 400 &&
          candidate.statusCode < 500
        ? candidate.statusCode
        : [400, 403, 404, 409, 413, 415, 422, 503].includes(candidate.status ?? 0)
          ? candidate.status!
          : 500;
    const safeCode = typeof candidate.code === "string" && [
      "META_CHANNEL_REQUIRED", "META_TEMPLATE_REJECTED", "META_TEMPLATE_SUBMISSION_UNKNOWN",
      "META_TEMPLATE_NAME_CONFLICT", "IDEMPOTENCY_CONFLICT",
      "PARTNER_CREDENTIAL_REVOKED", "BROKER_CHANNEL_REQUIRED", "PARTNER_QR_CHANNEL_REQUIRED",
      "PARTNER_MEDIA_NOT_READY", "PARTNER_MEDIA_UPLOAD_INVALID", "PARTNER_MEDIA_UPLOAD_CONFLICT",
      "MEDIA_NOT_READY",
    ].includes(candidate.code) ? candidate.code : undefined;
    const code = safeCode ?? (status === 400
        ? "INVALID_REQUEST"
        : status === 404
          ? "NOT_FOUND"
          : status === 500
            ? "INTERNAL_ERROR"
            : "MESSAGING_UNAVAILABLE");
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
  const uploadAuthority = [authenticateRequest(options), partnerMediaPermission(['media:upload'])];
  const mediaSender = [authenticateRequest(options), partnerMediaPermission(['messaging:send', 'media:send'])];
  const mediaParams = z.strictObject({ id: z.uuid(), mediaId: z.uuid() });
  const binaryHeaders = z.object({
    'content-type': z.literal('application/octet-stream'), 'x-jrc-media-mime': z.enum(SUPPORTED_UPLOAD_MIME_TYPES),
    'x-jrc-media-kind': z.enum(['image', 'audio', 'video', 'document']), 'x-jrc-media-name': z.string().min(1).max(765), 'idempotency-key': z.uuid(),
  });
  const mediaProblems = Object.fromEntries([400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503].map(status => [status, ProblemDetailsSchema]));
  if (!app.hasContentTypeParser('application/octet-stream')) app.addContentTypeParser('application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  api.post('/v1/messaging/channels/:id/media', {
    onRequest: [...uploadAuthority, async request => {
      if (request.headers['content-type'] !== 'application/octet-stream') throw Object.assign(new Error('Unsupported media type'), { statusCode: 415 });
    }], preHandler: uploadAuthority, bodyLimit: 16 * 1024 * 1024,
    schema: { params: idParams, querystring: emptyQuery, response: { 201: PartnerMediaMetadataSchema, ...mediaProblems } },
  }, async (request, reply) => {
    const h = binaryHeaders.parse(request.headers);
    if (!Buffer.isBuffer(request.body) || !request.body.length) throw Object.assign(new Error('Invalid upload'), { statusCode: 400 });
    let fileName: string;
    try { fileName = decodeURIComponent(h['x-jrc-media-name']); } catch { throw Object.assign(new Error('Invalid filename'), { statusCode: 400 }); }
    const identity = request.authentication!;
    if (identity.kind !== 'API_KEY') throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    if (!options.service.uploadPartnerMedia) throw Object.assign(new Error('Unavailable'), { status: 503 });
    const uploaded = PartnerMediaMetadataSchema.parse(await options.service.uploadPartnerMedia(identity.organizationId, request.params.id,
      { bytes: new Uint8Array(request.body), mimeType: h['x-jrc-media-mime'], kind: h['x-jrc-media-kind'], fileName, idempotencyKey: h['idempotency-key'] }, identity.apiKeyId));
    for (const guard of uploadAuthority) { await guard(request, reply); if (reply.sent) return reply; }
    return reply.code(201).header('Location', `/v1/messaging/channels/${request.params.id}/media/${uploaded.id}`).send(uploaded);
  });
  api.get('/v1/messaging/channels/:id/media/:mediaId', {
    preHandler: uploadAuthority, schema: { params: mediaParams, querystring: emptyQuery, response: { 200: PartnerMediaMetadataSchema, ...mediaProblems } },
  }, async (request, reply) => {
    const identity = request.authentication!;
    if (identity.kind !== 'API_KEY') throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    if (!options.service.getPartnerMedia) throw Object.assign(new Error('Unavailable'), { status: 503 });
    const metadata = await options.service.getPartnerMedia(identity.organizationId, request.params.id, request.params.mediaId, identity.apiKeyId);
    for (const guard of uploadAuthority) { await guard(request, reply); if (reply.sent) return reply; }
    return reply.send(metadata);
  });
  api.post('/v1/messaging/channels/:id/partner-media', {
    preHandler: mediaSender, schema: { params: idParams, querystring: emptyQuery, headers: IdempotencyHeadersSchema,
      body: PartnerMediaRequestSchema, response: { 202: MessageViewSchema.extend({ conversationId: z.uuid() }), ...mediaProblems } },
  }, async (request, reply) => {
    const identity = request.authentication!;
    if (identity.kind !== 'API_KEY') throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
    if (!options.service.sendPartnerMedia) throw Object.assign(new Error('Unavailable'), { status: 503 });
    return reply.code(202).send(await options.service.sendPartnerMedia(identity.organizationId, request.params.id, request.body, request.headers['idempotency-key'], identity.apiKeyId));
  });
  api.post('/v1/messaging/channels/:id/partner-text', {
    preHandler: [authenticateRequest(options), partnerSenderPermission],
    schema: { params: idParams, querystring: emptyQuery, headers: IdempotencyHeadersSchema,
      body: PartnerTextRequestSchema, response: {202: MessageViewSchema.extend({conversationId:z.uuid()}),
        400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,
        409:ProblemDetailsSchema,413:ProblemDetailsSchema,415:ProblemDetailsSchema,422:ProblemDetailsSchema,
        429:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema} },
  }, async (request, reply) => {
    const context = request.authentication;
    if (context?.kind !== 'API_KEY') throw Object.assign(new Error('Forbidden'), {statusCode:403});
    if (!options.service.sendPartnerText) throw Object.assign(new Error('Unavailable'), {status:503});
    return reply.code(202).send(await options.service.sendPartnerText(context.organizationId,
      request.params.id, request.body, request.headers['idempotency-key'], context.apiKeyId));
  });
  api.get('/v1/messaging/conversations/:id/qr-outbound-observations',{
    preHandler:read,schema:{params:idParams,querystring:emptyQuery,response:{200:QrOutboundObservationsResponseSchema}},
  },request=>{
    if(!options.service.listQrOutboundObservations)throw Object.assign(new Error('MESSAGING_UNAVAILABLE'),{status:503});
    return options.service.listQrOutboundObservations(tenant(request),request.params.id);
  });
  api.get('/v1/messaging/conversations/:id/qr-dispatch-attempts',{
    preHandler:read,schema:{params:idParams,querystring:emptyQuery,response:{200:QrDispatchAttemptsResponseSchema}},
  },request=>{
    if(!options.service.listQrDispatchAttempts)throw Object.assign(new Error('MESSAGING_UNAVAILABLE'),{status:503});
    return options.service.listQrDispatchAttempts(tenant(request),request.params.id);
  });
  api.post('/v1/messaging/qr-dispatch-attempts/:id/abandon',{
    preHandler:administerAutomation,schema:{params:idParams,querystring:emptyQuery,body:AbandonQrDispatchAttemptRequestSchema,response:{200:QrDispatchAttemptViewSchema}},
  },request=>{
    if(!options.service.abandonQrDispatchAttempt)throw Object.assign(new Error('MESSAGING_UNAVAILABLE'),{status:503});
    return options.service.abandonQrDispatchAttempt(tenant(request),request.params.id,request.body,request.authentication!.actorId!);
  });
  api.post('/v1/messaging/qr-outbound-observations/:id/abandon',{
    preHandler:administerAutomation,schema:{params:idParams,querystring:emptyQuery,body:AbandonQrOutboundObservationRequestSchema,response:{200:QrOutboundObservationViewSchema}},
  },request=>{
    if(!options.service.abandonQrOutboundObservation)throw Object.assign(new Error('MESSAGING_UNAVAILABLE'),{status:503});
    return options.service.abandonQrOutboundObservation(tenant(request),request.params.id,request.body,request.authentication!.actorId!);
  });
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
      // Authentication can change while the private object is being read.
      // Recheck immediately before releasing bytes or attachment headers.
      for (const guard of read) {
        await guard(request, reply);
        if (reply.sent) return reply;
      }
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
    "/v1/messaging/channels/:id/templates/:templateId/status",
    {
      preHandler: read,
      schema: {
        params: templateStatusParams,
        querystring: emptyQuery,
        response: { 200: TemplateStatusResponseSchema },
      },
    },
    request => options.service.getTemplateStatus(tenant(request), request.params.id, request.params.templateId),
  );
  api.post(
    "/v1/messaging/channels/:id/templates",
    {
      preHandler: administerAutomation,
      schema: {
        params: idParams,
        headers: IdempotencyHeadersSchema,
        querystring: emptyQuery,
        body: CreateTextTemplateRequestSchema,
        response: { 202: SubmittedTemplateSchema },
      },
    },
    async (request, reply) => reply.code(202).send(await options.service.createTextTemplate(
      tenant(request), request.params.id, request.body, request.headers["idempotency-key"],
    )),
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
  api.get(
    "/v1/messaging/conversations/:id",
    {preHandler:read,schema:{params:idParams,querystring:emptyQuery,response:{200:ConversationViewSchema}}},
    async (request,reply) => {
      reply.header('cache-control','no-store');
      if(!options.service.getConversation)throw Object.assign(new Error('Conversation lookup unavailable'),{status:503});
      return options.service.getConversation(tenant(request),request.params.id);
    },
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
