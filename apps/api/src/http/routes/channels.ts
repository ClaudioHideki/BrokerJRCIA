import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BindChannelAutomationV1Schema, BindChannelDestinationV1Schema, ChannelAutomationV1Schema,
  ChannelListV1Schema, ChannelMutationV1Schema, ChannelV1Schema, CreateChannelResponseV1Schema,
  CreateChannelV1Schema, IdempotencyHeadersSchema, PairChannelResponseV1Schema, PatchChannelV1Schema,
  PROBLEM_CONTENT_TYPE, ProblemDetailsSchema } from '@jrc/contracts';
import type { ChannelFacade } from '../../modules/channels/facade.js';
import { ChannelFacadeError } from '../../modules/channels/facade.js';
import type { Role } from '../plugins/authorization.js';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import { registerRequestContext } from '../plugins/request-context.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';

export interface ChannelRouteOptions extends AuthenticationOptions {
  service: ChannelFacade;
  resolveCurrentRole(userId: string, organizationId: string): Promise<Role | null>;
  now?: () => Date;
  requestTimeoutMs?: number;
}

export async function registerChannelRoutes(app: FastifyInstance, options: ChannelRouteOptions) {
  app.decorateRequest('authentication', null);
  await registerRequestContext(app, { ...(options.now ? { now: options.now } : {}),
    ...(options.requestTimeoutMs ? { timeoutMs: options.requestTimeoutMs } : {}) });
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const operational = tenantOperationalProblem(error, request.id);
    if (operational) return reply.code(operational.status).type(PROBLEM_CONTENT_TYPE).send(operational);
    const candidate = error as { validation?: unknown; statusCode?: number; code?: string };
    const status = error instanceof ChannelFacadeError ? error.status : candidate.validation || error instanceof z.ZodError ? 400
      : [400, 404, 409, 503].includes(candidate.statusCode ?? 0) ? candidate.statusCode! : 500;
    const code = error instanceof ChannelFacadeError ? error.code : status === 400 ? 'INVALID_REQUEST'
      : typeof candidate.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate.code) ? candidate.code : 'CHANNEL_OPERATION_FAILED';
    return reply.code(status).type(PROBLEM_CONTENT_TYPE).send({ type: 'about:blank', title: code, status, code,
      requestId: request.id });
  });
  const authentication = authenticateRequest(options);
  const role = (write: boolean,admin=false) => async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.authentication;
    const current = auth?.kind === 'JWT' ? await options.resolveCurrentRole(auth.actorId, auth.organizationId) : null;
    if (!current || (write && current === 'VIEWER') || (admin && current!=='OWNER' && current!=='ADMIN')) return reply.code(403).type(PROBLEM_CONTENT_TYPE)
      .send({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'FORBIDDEN', requestId: request.id });
  };
  const read = [authentication, role(false)], write = [authentication, role(true)],manage=[authentication,role(true,true)];
  const api = app.withTypeProvider<ZodTypeProvider>();
  const params = z.strictObject({ id: z.uuid() }), empty = z.strictObject({});
  const org = (request: FastifyRequest) => request.authentication!.organizationId;
  const actor = (request: FastifyRequest) => request.authentication!.actorId!;
  const context = (request: FastifyRequest) => ({ credentialKind: 'JWT' as const, organizationId: org(request), actorId: actor(request),
    requestId: request.id, deadline: request.operationDeadline, signal: request.operationSignal });

  api.get('/v1/channels', { preHandler: read, schema: { querystring: z.strictObject({includeArchived:z.enum(['true','false']).optional()}), response: { 200: ChannelListV1Schema,
    400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema } } }, request => options.service.list(org(request),request.query.includeArchived==='true'));
  api.post('/v1/channels/:id/archive',{preHandler:manage,schema:{params,querystring:empty,body:z.strictObject({archived:z.boolean()}),response:{200:ChannelV1Schema}}},request=>options.service.setArchived(org(request),request.params.id,request.body.archived,actor(request)));
  api.get('/v1/channels/:id', { preHandler: read, schema: { params, querystring: empty, response: { 200: ChannelV1Schema,
    400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema } } },
  request => options.service.get(org(request), request.params.id));
  api.patch('/v1/channels/:id', { preHandler: write, schema: { params, querystring: empty,
    body: PatchChannelV1Schema, response: { 200: ChannelV1Schema, 400: ProblemDetailsSchema,
      401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema, 409: ProblemDetailsSchema } } },
  request => options.service.patch(org(request), request.params.id, request.body));
  api.get('/v1/channels/:id/status', { preHandler: read, schema: { params, querystring: empty,
    response: { 200: ChannelV1Schema, 400: ProblemDetailsSchema, 401: ProblemDetailsSchema,
      403: ProblemDetailsSchema, 404: ProblemDetailsSchema, 503: ProblemDetailsSchema } } },
  request => options.service.status(context(request), request.params.id));
  api.post('/v1/channels', { preHandler: write, schema: { headers: IdempotencyHeadersSchema, querystring: empty,
    body: CreateChannelV1Schema, response: { 201: CreateChannelResponseV1Schema, 202: CreateChannelResponseV1Schema,
      400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 409: ProblemDetailsSchema, 503: ProblemDetailsSchema } } },
  async (request, reply) => {
    const result = await options.service.create(context(request), actor(request), request.body, request.headers['idempotency-key']);
    return reply.code(result.provider === 'META' || result.pending ? 202 : 201).send(result);
  });
  api.post('/v1/channels/:id/pair', { preHandler: write, schema: { params, headers: IdempotencyHeadersSchema, querystring: empty,
    body: empty, response: { 200: PairChannelResponseV1Schema, 202: PairChannelResponseV1Schema,
      400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema,
      409: ProblemDetailsSchema, 503: ProblemDetailsSchema } } }, async (request, reply) => {
    reply.header('Pragma', 'no-cache');
    const result = await options.service.pair(context(request), request.params.id, request.headers['idempotency-key']);
    return reply.code(result.pending && result.action.type === 'NONE' ? 202 : 200).send(result);
  });
  api.post('/v1/channels/:id/reconnect', { preHandler: write, schema: { params, headers: IdempotencyHeadersSchema,
    querystring: empty, body: empty, response: { 200: PairChannelResponseV1Schema, 202: PairChannelResponseV1Schema,
      400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema,
      409: ProblemDetailsSchema, 503: ProblemDetailsSchema } } }, async (request, reply) => {
    reply.header('Pragma', 'no-cache');
    const result = await options.service.reconnect(context(request), request.params.id, request.headers['idempotency-key']);
    return reply.code(result.pending && result.action.type === 'NONE' ? 202 : 200).send(result);
  });
  api.post('/v1/channels/:id/disconnect', { preHandler: write, schema: { params, headers: IdempotencyHeadersSchema,
    querystring: empty, body: empty, response: { 200: ChannelMutationV1Schema, 202: ChannelMutationV1Schema,
      400: ProblemDetailsSchema, 401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema,
      409: ProblemDetailsSchema, 503: ProblemDetailsSchema } } }, async (request, reply) => {
    const result = await options.service.disconnect(context(request), request.params.id, request.headers['idempotency-key']);
    return reply.code(result.pending ? 202 : 200).send(result);
  });
  api.get('/v1/channels/:id/automation', { preHandler: read, schema: { params, querystring: empty,
    response: { 200: ChannelAutomationV1Schema, 400: ProblemDetailsSchema, 401: ProblemDetailsSchema,
      403: ProblemDetailsSchema, 404: ProblemDetailsSchema } } },
  request => options.service.getAutomation(org(request), request.params.id));
  api.put('/v1/channels/:id/automation', { preHandler: manage, schema: { params, querystring: empty,
    body: BindChannelAutomationV1Schema, response: { 200: ChannelAutomationV1Schema, 400: ProblemDetailsSchema,
      401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema, 409: ProblemDetailsSchema } } },
  request => options.service.bindAutomation(org(request), request.params.id, request.body));
  api.put('/v1/channels/:id/destination', { preHandler: manage, schema: { params, querystring: empty,
    body: BindChannelDestinationV1Schema, response: { 200: ChannelV1Schema, 400: ProblemDetailsSchema,
      401: ProblemDetailsSchema, 403: ProblemDetailsSchema, 404: ProblemDetailsSchema, 409: ProblemDetailsSchema, 503: ProblemDetailsSchema } } },
  request => options.service.bindDestination(org(request), request.params.id, request.body, actor(request)));
}
