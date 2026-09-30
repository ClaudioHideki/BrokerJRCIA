import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerPlatformSupportRoutes } from './support.js';
import { registerGroupRemovalRoutes } from './group-removal.js';
import { SupportError, type SupportService } from '../../modules/support/service.js';
import { tenantOperationalProblem } from "../../modules/tenancy/operational-limits.js";
import { z } from "zod";
import { CreateCommercialPlanSchema, CreateCommercialPlanVersionSchema, AssignCommercialPlanSchema, CommercialPlanCatalogSchema, CommercialPlanVersionSchema, CommercialAssignmentSchema } from '@jrc/contracts';
import { CreateEconomicGroupSchema, AssignGroupOrganizationsSchema, EconomicGroupSchema, UpdateEconomicGroupSchema,
  RemoveEconomicGroupSchema, EconomicGroupRemovalPreviewSchema, EconomicGroupRemovalResultSchema } from '@jrc/contracts';
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
import {LifecycleError,type LifecycleService} from '../../modules/lifecycle/service.js';
import {DeletionPreviewSchema,DeletionRequestedSchema,DeletionStatusSchema,RequestDeletionSchema,ReconcileDeletionSchema} from '@jrc/contracts';
export interface PlatformRouteOptions {
  support?: SupportService;
  lifecycle?: LifecycleService;
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
          error instanceof LifecycleError ? error.status : error instanceof PlatformError
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
          error instanceof LifecycleError || error instanceof PlatformError || error instanceof ChannelFacadeError ||
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
        const paginationCursor=action==='list'?(req.query as {cursor?:string}).cursor:undefined;
        return options.service.execute(
          token,
          reason,
          action,
          id,
          bodySchema
            ? (bodySchema.parse(req.body) as PlatformInput)
            : undefined,
          ...(action==='list'?[paginationCursor]:[]),
        );
      };
      const groupReason = (req: FastifyRequest) => z.string().trim().min(5).max(500).parse(req.headers['x-platform-reason']);
      if(options.lifecycle){
        const channelDeletionParams=idParams.extend({channelId:z.uuid()});
        const companyStatusParams=idParams.extend({operationId:z.uuid()});
        const channelStatusParams=channelDeletionParams.extend({operationId:z.uuid()});
        const globalActor=async(req:FastifyRequest,write=false)=>{
          const session=await options.service.session(write?await mutation(req):cookie(req));
          if(session.user.role!=='SUPER_ADMIN')throw new PlatformError(403,'PLATFORM_FORBIDDEN');
          return session.user.id;
        };
        if(options.lifecycle.groups)await registerGroupRemovalRoutes(scoped,{service:options.lifecycle.groups,authorize:globalActor});
        scoped.post('/organizations/:id/deletion/:operationId/reconcile',{schema:{params:companyStatusParams,querystring:z.strictObject({}),body:ReconcileDeletionSchema,response:{202:DeletionRequestedSchema}}},
          async(req,reply)=>{const actor=await globalActor(req,true),params=companyStatusParams.parse(req.params),input=ReconcileDeletionSchema.parse(req.body);
            return reply.code(202).send(await options.lifecycle!.requestReconciliation(params.id,params.id,params.operationId,input.reason,'PLATFORM',actor));});
        scoped.post('/organizations/:id/channels/:channelId/deletion/:operationId/reconcile',{schema:{params:channelStatusParams,querystring:z.strictObject({}),body:ReconcileDeletionSchema,response:{202:DeletionRequestedSchema}}},
          async(req,reply)=>{const actor=await globalActor(req,true),params=channelStatusParams.parse(req.params),input=ReconcileDeletionSchema.parse(req.body);
            return reply.code(202).send(await options.lifecycle!.requestReconciliation(params.id,params.channelId,params.operationId,input.reason,'PLATFORM',actor));});
        scoped.get('/organizations/:id/deletion-preview',{schema:{params:idParams,querystring:z.strictObject({}),response:{200:DeletionPreviewSchema}}},
          async req=>{await globalActor(req);return options.lifecycle!.previewOrganization(idParams.parse(req.params).id);});
        scoped.post('/organizations/:id/deletion',{schema:{params:idParams,querystring:z.strictObject({}),body:RequestDeletionSchema,response:{202:DeletionRequestedSchema}}},
          async(req,reply)=>{
            const actor=await globalActor(req,true),input=RequestDeletionSchema.parse(req.body);
            return reply.code(202).send(await options.lifecycle!.requestOrganization(idParams.parse(req.params).id,
              input.confirmationName,input.reason,actor));
          });
        scoped.get('/organizations/:id/deletion/:operationId',{schema:{params:companyStatusParams,querystring:z.strictObject({}),response:{200:DeletionStatusSchema}}},
          async req=>{await globalActor(req);const params=companyStatusParams.parse(req.params);
            return options.lifecycle!.status(params.id,params.id,params.operationId);});
        scoped.get('/organizations/:id/channels/:channelId/deletion-preview',{schema:{params:channelDeletionParams,querystring:z.strictObject({}),response:{200:DeletionPreviewSchema}}},
          async req=>{await globalActor(req);const params=channelDeletionParams.parse(req.params);
            return options.lifecycle!.previewChannel(params.id,params.channelId);});
        scoped.post('/organizations/:id/channels/:channelId/deletion',{schema:{params:channelDeletionParams,querystring:z.strictObject({}),body:RequestDeletionSchema,response:{202:DeletionRequestedSchema}}},
          async(req,reply)=>{const actor=await globalActor(req,true),params=channelDeletionParams.parse(req.params),input=RequestDeletionSchema.parse(req.body);
            return reply.code(202).send(await options.lifecycle!.requestChannel(params.id,params.channelId,input.confirmationName,input.reason,'PLATFORM',actor));});
        scoped.get('/organizations/:id/channels/:channelId/deletion/:operationId',{schema:{params:channelStatusParams,querystring:z.strictObject({}),response:{200:DeletionStatusSchema}}},
          async req=>{await globalActor(req);const params=channelStatusParams.parse(req.params);
            return options.lifecycle!.status(params.id,params.channelId,params.operationId);});
      }
      if (options.support) await registerPlatformSupportRoutes(scoped, {
        service: options.support,
        authorize: async (req, write) => {
          try {
            const token = write ? await mutation(req) : cookie(req);
            const session = await options.service.session(token);
            return { kind: 'PLATFORM', actorId: session.user.id };
          } catch (error) {
            if (error instanceof PlatformError) throw new SupportError(error.code,error.statusCode);
            throw error;
          }
        },
      });
      scoped.get('/groups', { schema: { querystring: z.strictObject({cursor:z.string().min(1).max(1024).optional()}), response: { 200: z.strictObject({ data: z.array(EconomicGroupSchema), nextCursor:z.string().optional() }) } } },
        req => options.service.listGroups(cookie(req), groupReason(req), (req.query as {cursor?:string}).cursor));
      scoped.get('/commercial-plans',{schema:{querystring:z.strictObject({}),response:{200:CommercialPlanCatalogSchema}}},
        req=>options.service.listCommercialPlans(cookie(req),groupReason(req)));
      scoped.post('/commercial-plans',{schema:{querystring:z.strictObject({}),body:CreateCommercialPlanSchema,response:{201:CommercialPlanVersionSchema}}},
        async(req,reply)=>reply.code(201).send(await options.service.createCommercialPlan(await mutation(req),groupReason(req),req.body)));
      scoped.post('/commercial-plans/:id/versions',{schema:{params:idParams,querystring:z.strictObject({}),body:CreateCommercialPlanVersionSchema,response:{201:CommercialPlanVersionSchema}}},
        async(req,reply)=>reply.code(201).send(await options.service.createCommercialPlanVersion(await mutation(req),groupReason(req),idParams.parse(req.params).id,req.body)));
      scoped.get('/organizations/:id/commercial-plan',{schema:{params:idParams,querystring:z.strictObject({}),response:{200:CommercialAssignmentSchema}}},
        req=>options.service.getCommercialPlan(cookie(req),groupReason(req),idParams.parse(req.params).id));
      scoped.put('/organizations/:id/commercial-plan',{schema:{params:idParams,querystring:z.strictObject({}),body:AssignCommercialPlanSchema,response:{200:CommercialAssignmentSchema}}},
        async req=>options.service.assignCommercialPlan(await mutation(req),groupReason(req),idParams.parse(req.params).id,req.body));
      scoped.post('/groups', { schema: { querystring: z.strictObject({}), body: CreateEconomicGroupSchema, response: { 201: EconomicGroupSchema } } },
        async (req, reply) => reply.code(201).send(await options.service.createGroup(await mutation(req), groupReason(req), CreateEconomicGroupSchema.parse(req.body))));
      scoped.put('/groups/:id/organizations', { schema: { params: idParams, querystring: z.strictObject({}), body: AssignGroupOrganizationsSchema, response: { 200: EconomicGroupSchema } } },
        async req => options.service.assignGroupOrganizations(await mutation(req), groupReason(req), (req.params as {id:string}).id, AssignGroupOrganizationsSchema.parse(req.body)));
      scoped.patch('/groups/:id', { schema: { params: idParams, querystring: z.strictObject({}), body: UpdateEconomicGroupSchema, response: { 200: EconomicGroupSchema } } },
        async req => options.service.updateEconomicGroup(await mutation(req), groupReason(req), (req.params as {id:string}).id, UpdateEconomicGroupSchema.parse(req.body)));
      scoped.get('/groups/:id/removal-preview', { schema: { params: idParams, querystring: z.strictObject({}), response: { 200: EconomicGroupRemovalPreviewSchema } } },
        req => options.service.previewEconomicGroupRemoval(cookie(req), groupReason(req), (req.params as {id:string}).id));
      scoped.delete('/groups/:id', { schema: { params: idParams, querystring: z.strictObject({}), body: RemoveEconomicGroupSchema, response: { 200: EconomicGroupRemovalResultSchema } } },
        async req => options.service.removeEconomicGroup(await mutation(req), groupReason(req), (req.params as {id:string}).id, RemoveEconomicGroupSchema.parse(req.body)));
      scoped.get(
        "/organizations",
        {
          schema: {
            querystring: z.strictObject({cursor:z.string().min(1).max(1024).optional()}),
            response: {
              200: z.object({ organizations: z.array(organizationDto),nextCursor:z.string().optional() }),
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
      scoped.get('/organizations/:id/channels',{schema:{params:idParams,querystring:z.strictObject({
        pageSize:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().min(1).max(256).optional(),
      })}},async req=>{
        const org=idParams.parse(req.params).id;await options.service.authorizeChannels(cookie(req),z.string().trim().min(5).max(500).parse(req.headers['x-platform-reason']),org,false);
        if(!options.channels)throw new PlatformError(503,'CHANNELS_UNAVAILABLE');
        const {pageSize,cursor}=z.strictObject({pageSize:z.coerce.number().int().min(1).max(100).optional(),cursor:z.string().min(1).max(256).optional()}).parse(req.query);
        return options.channels.list(org,true,{pageSize:pageSize??50,...(cursor?{cursor}:{})});
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
