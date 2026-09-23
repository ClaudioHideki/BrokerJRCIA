import type { FastifyInstance, FastifyRequest } from "fastify";
import { tenantOperationalProblem } from "../../modules/tenancy/operational-limits.js";
import { z } from "zod";
import {
  ChatwootStatusSchema,
  BindChatwootAccountSchema,
  ConnectChatwootSchema,
  IntegrationJobsSchema,
  ReconcileIntegrationJobSchema,
  ApproveDestinationSchema,
  ChatwootDestinationSchema,
} from "@jrc/contracts";
import { ChatwootDestinationError } from '../../modules/integrations/chatwoot-destination.js';
import {
  IntegrationError,
  type ChatwootService,
} from "../../modules/integrations/chatwoot-service.js";
import { ChatwootError } from "../../modules/integrations/chatwoot-client.js";
import {
  ProvisionChatwootInput,
  type createChatwootProvisioner,
} from "../../modules/integrations/chatwoot-provisioner.js";
import {
  validatorCompiler,
  serializerCompiler,
} from "fastify-type-provider-zod";
import {
  PlatformError,
  type PlatformService,
  type PlatformAction,
  type PlatformInput,
} from "../../modules/platform/service.js";
import {ChannelFacadeError,type ChannelFacade} from '../../modules/channels/facade.js';
export interface PlatformRouteOptions {
  channels?:ChannelFacade;
  service: PlatformService;
  origin: string;
  secureCookies: boolean;
  chatwoot?: ChatwootService | undefined;
  provisioner?: ReturnType<typeof createChatwootProvisioner> | undefined;
}
const limits = z
  .object({
    maxInstances: z.number().int().positive().max(100000000),
    maxUsers: z.number().int().positive().max(100000000),
    messagesPerDay: z.number().int().positive().max(100000000),
    maxPendingMessages: z.number().int().positive().max(100000000),
  })
  .strict();
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).max(256);
const login = z
  .object({
    email,
    password,
    totp: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
const create = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    ownerEmail: email,
    ownerPassword: password,
    flowsEnabled: z.boolean().optional(),
    plan: z.string().trim().min(1).max(80).optional(),
    limits: limits.optional(),
  })
  .strict();
const update = z
  .object({
    status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
    flowsEnabled: z.boolean().optional(),
    plan: z.string().trim().min(1).max(80).optional(),
    limits: limits.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const membership = z
  .object({
    email,
    password: password.optional(),
    role: z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]),
    status: z.enum(["ACTIVE", "DISABLED"]),
  })
  .strict();
const userDto = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["SUPER_ADMIN", "SUPPORT"]),
});
const sessionDto = z.object({
  user: userDto,
  csrfToken: z.string(),
  expiresAt: z.string(),
});
const organizationDto = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(["ACTIVE", "SUSPENDED", "DISABLED"]),
  plan: z.string(),
  flowsEnabled: z.boolean().optional(),
  limits: limits.optional(),
});
const okDto = z.object({ ok: z.literal(true) });
const idParams = z.object({ id: z.uuid() });
function cookie(req: FastifyRequest) {
  const raw = req.headers.cookie
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("platform_session="))
    ?.slice(17);
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw))
    throw new PlatformError(401, "PLATFORM_INVALID_SESSION");
  return raw;
}
export async function registerPlatformRoutes(
  app: FastifyInstance,
  options: PlatformRouteOptions,
) {
  if (new URL(options.origin).origin !== options.origin)
    throw new Error("PLATFORM_ORIGIN must be an exact origin");
  await app.register(
    async (scoped) => {
      scoped.setValidatorCompiler(validatorCompiler);
      scoped.setSerializerCompiler(serializerCompiler);
      scoped.setErrorHandler((error, req, reply) => {
        const operationalProblem = tenantOperationalProblem(error, req.id);
        if (operationalProblem)
          return reply.code(operationalProblem.status).send(operationalProblem);
        const duplicate = (error as { code?: string }).code === "23505";
        const status =
          error instanceof PlatformError
            ? error.statusCode
            : error instanceof ChannelFacadeError || error instanceof IntegrationError || error instanceof ChatwootDestinationError
              ? error.status
              : error instanceof ChatwootError
                ? 502
                : error instanceof z.ZodError ||
                    (error as { validation?: unknown }).validation
                  ? 400
                  : duplicate
                    ? 409
                    : 500;
        const code =
          error instanceof PlatformError || error instanceof ChannelFacadeError ||
          error instanceof IntegrationError ||
          error instanceof ChatwootDestinationError ||
          error instanceof ChatwootError
            ? error.code
            : status === 400
              ? "INVALID_REQUEST"
              : duplicate
                ? "INTEGRATION_ALREADY_BOUND"
                : "PLATFORM_UNAVAILABLE";
        reply.code(status).type("application/problem+json").send({
          type: "about:blank",
          title: code,
          status,
          code,
          requestId: req.id,
        });
      });
      scoped.addHook("onRequest", async (req, reply) => {
        reply.header("Cache-Control", "no-store");
        if (req.method !== "GET" && req.headers.origin !== options.origin)
          throw new PlatformError(403, "PLATFORM_ORIGIN_REJECTED");
      });
      const cookieValue = (token: string, maxAge = 900) =>
        `platform_session=${token}; Path=/v1/platform; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${options.secureCookies ? "; Secure" : ""}`;
      scoped.get(
        "/auth/config",
        {
          schema: { response: { 200: z.object({ mfaRequired: z.boolean() }) } },
        },
        async () => ({ mfaRequired: options.service.mfaRequired !== false }),
      );
      scoped.post(
        "/auth/login",
        { schema: { body: login, response: { 200: sessionDto } } },
        async (req, reply) => {
          const body = login.parse(req.body);
          const { token, ...session } = await options.service.login(
            body.email,
            body.password,
            body.totp ?? "",
            req.ip,
          );
          reply.header("Set-Cookie", cookieValue(token));
          return session;
        },
      );
      scoped.get(
        "/auth/session",
        { schema: { response: { 200: sessionDto } } },
        async (req) => options.service.session(cookie(req)),
      );
      const mutation = async (req: FastifyRequest) => {
        const token = cookie(req);
        const session = await options.service.session(token);
        if (req.headers["x-csrf-token"] !== session.csrfToken)
          throw new PlatformError(403, "PLATFORM_CSRF_REJECTED");
        return token;
      };
      scoped.post(
        "/auth/logout",
        { schema: { response: { 200: okDto } } },
        async (req, reply) => {
          await options.service.logout(await mutation(req));
          reply.header("Set-Cookie", cookieValue("", 0));
          return { ok: true };
        },
      );
      const run = async (
        req: FastifyRequest,
        action: PlatformAction,
        bodySchema?: z.ZodType,
      ) => {
        const token = req.method === "GET" ? cookie(req) : await mutation(req);
        const reason = z
          .string()
          .trim()
          .min(5)
          .max(500)
          .parse(req.headers["x-platform-reason"]);
        const id = (req.params as { id?: string }).id;
        if (id) z.uuid().parse(id);
        return options.service.execute(
          token,
          reason,
          action,
          id,
          bodySchema
            ? (bodySchema.parse(req.body) as PlatformInput)
            : undefined,
        );
      };
      scoped.get(
        "/organizations",
        {
          schema: {
            response: {
              200: z.object({ organizations: z.array(organizationDto) }),
            },
          },
        },
        (req) => run(req, "list"),
      );
      scoped.post(
        "/organizations",
        {
          schema: {
            body: create,
            response: { 200: z.object({ organization: organizationDto }) },
          },
        },
        (req) => run(req, "create", create),
      );
      scoped.patch(
        "/organizations/:id",
        {
          schema: { params: idParams, body: update, response: { 200: okDto } },
        },
        (req) => run(req, "update", update),
      );
      scoped.get(
        "/organizations/:id/memberships",
        {
          schema: {
            params: idParams,
            response: {
              200: z.object({
                memberships: z.array(
                  z.object({
                    userId: z.uuid(),
                    email: z.email(),
                    role: z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]),
                    status: z.enum(["ACTIVE", "DISABLED"]),
                  }),
                ),
              }),
            },
          },
        },
        (req) => run(req, "memberships"),
      );
      scoped.put(
        "/organizations/:id/memberships",
        {
          schema: {
            params: idParams,
            body: membership,
            response: { 200: okDto },
          },
        },
        (req) => run(req, "membership", membership),
      );
      scoped.get(
        "/organizations/:id/monitor",
        {
          schema: {
            params: idParams,
            response: {
              200: z.object({
                connections: z.number().int(),
                queue: z.number().int(),
                failures: z.number().int(),
                webhooks: z.number().int(),
              }),
            },
          },
        },
        (req) => run(req, "monitor"),
      );
      scoped.post(
        "/organizations/:id/support-acknowledgment",
        {
          schema: {
            params: idParams,
            body: z.object({}).strict(),
            response: { 200: okDto },
          },
        },
        (req) => run(req, "acknowledge", z.object({}).strict()),
      );
      scoped.get('/organizations/:id/channels',{schema:{params:idParams,querystring:z.strictObject({})}},async req=>{
        const org=idParams.parse(req.params).id;await options.service.authorizeChannels(cookie(req),z.string().trim().min(5).max(500).parse(req.headers['x-platform-reason']),org,false);
        if(!options.channels)throw new PlatformError(503,'CHANNELS_UNAVAILABLE');return options.channels.list(org,true);
      });
      scoped.post('/organizations/:id/channels/:channelId/archive',{schema:{params:idParams.extend({channelId:z.uuid()}),querystring:z.strictObject({}),body:z.strictObject({archived:z.boolean()})}},async req=>{
        const {id:org,channelId}=idParams.extend({channelId:z.uuid()}).parse(req.params),token=await mutation(req);
        const actor=await options.service.authorizeChannels(token,z.string().trim().min(5).max(500).parse(req.headers['x-platform-reason']),org,true);
        if(!options.channels)throw new PlatformError(503,'CHANNELS_UNAVAILABLE');
        return options.channels.setArchived(org,channelId,z.strictObject({archived:z.boolean()}).parse(req.body).archived,undefined,actor);
      });
      const integration = async (req: FastifyRequest) => {
        const token = req.method === "GET" ? cookie(req) : await mutation(req);
        const reason = z
          .string()
          .trim()
          .min(5)
          .max(500)
          .parse(req.headers["x-platform-reason"]);
        const org = z.uuid().parse((req.params as { id: string }).id);
        const actor = await options.service.authorizeIntegration(
          token,
          reason,
          org,
          req.method !== "GET",
        );
        if (!options.chatwoot)
          throw new IntegrationError("CHATWOOT_NOT_CONFIGURED", 503);
        return { org, actor, service: options.chatwoot };
      };
      const base = "/organizations/:id/chatwoot";
      const empty = z.strictObject({});
      const schema = { params: idParams, querystring: empty };
      scoped.post(base + '/destination/approve', {
        schema: { ...schema, body: ApproveDestinationSchema, response: { 200: ChatwootDestinationSchema } },
      }, async req => {
        const token = await mutation(req);
        if (!options.chatwoot?.destinations.enabled)
          throw new IntegrationError('CHATWOOT_EXTERNAL_DESTINATIONS_DISABLED', 404);
        return options.service.approveChatwootDestination(token, String(req.headers['x-csrf-token']),
          z.string().trim().min(5).max(500).parse(req.headers['x-platform-reason']), idParams.parse(req.params).id,
          ApproveDestinationSchema.parse(req.body));
      });
      scoped.get(
        base,
        { schema: { ...schema, response: { 200: ChatwootStatusSchema } } },
        async (req) => {
          if (!options.chatwoot) {
            const token = cookie(req);
            await options.service.authorizeIntegration(
              token,
              z
                .string()
                .min(5)
                .max(500)
                .parse(req.headers["x-platform-reason"]),
              idParams.parse(req.params).id,
              false,
            );
            return {
              configured: false,
              baseUrl: null,
              provisioningAvailable: false,
              account: null,
              connections: [],
              jobs: {},
            };
          }
          const { org, service } = await integration(req);
          return service.status(org);
        },
      );
      scoped.put(
        base + "/account",
        {
          schema: {
            ...schema,
            body: BindChatwootAccountSchema,
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          return service.bindAccount(
            org,
            BindChatwootAccountSchema.parse(req.body),
            actor,
          );
        },
      );
      scoped.get(base + "/sources", { schema }, async (req) => {
        const { org, service } = await integration(req);
        return service.sources(org);
      });
      scoped.get(base + "/inboxes", { schema }, async (req) => {
        const { org, service } = await integration(req);
        return service.inboxes(org);
      });
      scoped.get(
        base + "/jobs",
        { schema: { ...schema, response: { 200: IntegrationJobsSchema } } },
        async (req) => {
          const { org, service } = await integration(req);
          return service.jobs(org);
        },
      );
      scoped.post(
        base + "/connections",
        {
          schema: {
            ...schema,
            body: ConnectChatwootSchema,
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          return service.connect(
            org,
            ConnectChatwootSchema.parse(req.body),
            actor,
          );
        },
      );
      const resourceSchema = {
        querystring: empty,
        params: z.strictObject({ id: z.uuid(), resourceId: z.uuid() }),
      };
      scoped.get(
        base + "/connections/:resourceId/agents",
        { schema: resourceSchema },
        async (req) => {
          const { org, service } = await integration(req);
          return service.agents(
            org,
            resourceSchema.params.parse(req.params).resourceId,
          );
        },
      );
      scoped.post(
        base + "/connections/:resourceId/agents",
        {
          schema: {
            ...resourceSchema,
            body: z.strictObject({
              userIds: z.array(z.number().int().positive()).min(1).max(100),
            }),
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          return service.addAgents(
            org,
            resourceSchema.params.parse(req.params).resourceId,
            z
              .object({
                userIds: z.array(z.number().int().positive()).min(1).max(100),
              })
              .parse(req.body).userIds,
            actor,
          );
        },
      );
      scoped.post(
        base + "/connections/:resourceId/retry",
        {
          schema: {
            ...resourceSchema,
            body: z.strictObject({
              replaceExistingWebhook: z.boolean().default(false),
            }),
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          return service.retryConnection(
            org,
            resourceSchema.params.parse(req.params).resourceId,
            z
              .object({ replaceExistingWebhook: z.boolean().default(false) })
              .parse(req.body).replaceExistingWebhook,
            actor,
          );
        },
      );
      scoped.post(
        base + "/jobs/:resourceId/reconcile",
        {
          schema: {
            ...resourceSchema,
            body: ReconcileIntegrationJobSchema,
            response: { 200: okDto },
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          const body = ReconcileIntegrationJobSchema.parse(req.body);
          return service.reconcileJob(
            org,
            resourceSchema.params.parse(req.params).resourceId,
            body.reason,
            body.remoteId,
            actor,
          );
        },
      );
      scoped.post(
        base + "/connections/:resourceId/reconcile",
        {
          schema: {
            ...resourceSchema,
            body: empty,
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, service } = await integration(req);
          return service.reconcileConnection(
            org,
            resourceSchema.params.parse(req.params).resourceId,
          );
        },
      );
      scoped.delete(base + '/connections/:resourceId',{schema:{...resourceSchema}},async req=>{const {org,actor,service}=await integration(req);return service.removeUnusedConnection(org,resourceSchema.params.parse(req.params).resourceId,actor);});
      scoped.patch(
        base + "/connections/:resourceId",
        {
          schema: {
            ...resourceSchema,
            body: z.strictObject({ enabled: z.boolean() }),
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          return service.setEnabled(
            org,
            resourceSchema.params.parse(req.params).resourceId,
            z.object({ enabled: z.boolean() }).parse(req.body).enabled,
            actor,
          );
        },
      );
      scoped.post(
        base + "/jobs/:resourceId/retry",
        {
          schema: {
            ...resourceSchema,
            body: z.strictObject({ reason: z.string().min(5).max(500) }),
            response: { 200: okDto },
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          return service.retryJob(
            org,
            resourceSchema.params.parse(req.params).resourceId,
            z.object({ reason: z.string() }).parse(req.body).reason,
            actor,
          );
        },
      );
      scoped.post(
        base + "/provision",
        {
          schema: {
            ...schema,
            body: ProvisionChatwootInput,
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, actor, service } = await integration(req);
          if (!options.provisioner)
            throw new IntegrationError("CHATWOOT_PLATFORM_NOT_CONFIGURED", 503);
          await options.provisioner.start(
            org,
            ProvisionChatwootInput.parse(req.body),
            actor,
          );
          return service.status(org);
        },
      );
      scoped.post(
        base + "/provision/resume",
        {
          schema: {
            ...schema,
            body: empty,
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, service } = await integration(req);
          if (!options.provisioner)
            throw new IntegrationError("CHATWOOT_PLATFORM_NOT_CONFIGURED", 503);
          await options.provisioner.resume(org);
          return service.status(org);
        },
      );
      const reconcile = z.strictObject({
        remoteId: z.number().int().positive().optional(),
      });
      scoped.post(
        base + "/provision/reconcile",
        {
          schema: {
            ...schema,
            body: reconcile,
            response: { 200: ChatwootStatusSchema },
          },
        },
        async (req) => {
          const { org, service } = await integration(req);
          if (!options.provisioner)
            throw new IntegrationError("CHATWOOT_PLATFORM_NOT_CONFIGURED", 503);
          await options.provisioner.reconcile(
            org,
            reconcile.parse(req.body).remoteId,
          );
          return service.status(org);
        },
      );
    },
    { prefix: "/v1/platform" },
  );
}
