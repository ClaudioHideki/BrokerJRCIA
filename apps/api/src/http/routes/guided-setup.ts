import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GuidedSetupRevisionSchema, GuidedSetupStartSchema, GuidedSetupUpdateSchema, IdempotencyHeadersSchema } from '@jrc/contracts';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import { GuidedSetupError, type GuidedSetupService, type SetupPrincipal } from '../../modules/guided-setup/service.js';
import { AutomationError } from '../../modules/automations/errors.js';
import { IdempotencyConflictError } from '../../modules/instances/idempotency.js';
import { SetupActivateInputSchema, SetupProofInputSchema, SetupTestInputSchema } from '../../modules/guided-setup/actions.js';

export interface GuidedSetupRouteOptions extends AuthenticationOptions {
  service: GuidedSetupService;
  resolveCurrentRole(userId: string, organizationId: string): Promise<Role | null>;
}
const problem = (reply: FastifyReply, request: FastifyRequest, status: number, code: string) =>
  reply.code(status).type('application/problem+json').send({ type: 'about:blank', title: code, code, status, requestId: request.id });
export async function registerGuidedSetupRoutes(app: FastifyInstance, options: GuidedSetupRouteOptions) {
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GuidedSetupError || error instanceof AutomationError) return problem(reply, request, error.statusCode, error.code);
    if (error instanceof IdempotencyConflictError) return problem(reply, request, error.status, error.code);
    const candidate = typeof error === 'object' && error !== null ? error as { validation?: unknown } : {};
    if (error instanceof z.ZodError || candidate.validation) return problem(reply, request, 400, 'GUIDED_SETUP_INVALID');
    return problem(reply, request, 503, 'GUIDED_SETUP_UNAVAILABLE');
  });
  const authentication = authenticateRequest(options);
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.authentication;
    const role = identity?.kind === 'JWT' ? await options.resolveCurrentRole(identity.actorId, identity.organizationId) : null;
    if (!role || !['OWNER', 'ADMIN'].includes(role)) return problem(reply, request, 403, 'GUIDED_SETUP_FORBIDDEN');
  };
  const principal = (request: FastifyRequest): SetupPrincipal => {
    const auth = request.authentication!;
    if (auth.kind !== 'JWT') throw new GuidedSetupError('GUIDED_SETUP_FORBIDDEN', 403);
    return { organizationId: auth.organizationId, actorId: auth.actorId };
  };
  const api = app.withTypeProvider<ZodTypeProvider>(), preHandler = [authentication, guard];
  const empty = z.strictObject({}), params = z.strictObject({ id: z.uuid() });
  api.get('/v1/guided-setups/availability', { preHandler, schema: { querystring: empty } }, request => options.service.availability(principal(request)));
  api.get('/v1/guided-setups', { preHandler, schema: { querystring: empty } }, request => options.service.list(principal(request)));
  api.post('/v1/guided-setups', { preHandler, schema: { querystring: empty, headers: IdempotencyHeadersSchema, body: GuidedSetupStartSchema } }, async (request, reply) =>
    reply.code(201).send(await options.service.start(principal(request), request.body, request.headers['idempotency-key'])));
  api.get('/v1/guided-setups/:id', { preHandler, schema: { params, querystring: empty } }, request => options.service.get(principal(request), request.params.id));
  api.put('/v1/guided-setups/:id', { preHandler, schema: { params, querystring: empty, headers: IdempotencyHeadersSchema, body: GuidedSetupUpdateSchema } }, request =>
    options.service.update(principal(request), request.params.id, request.body, request.headers['idempotency-key']));
  api.post('/v1/guided-setups/:id/cancel', { preHandler, schema: { params, querystring: empty, headers: IdempotencyHeadersSchema, body: GuidedSetupRevisionSchema } }, request =>
    options.service.cancel(principal(request), request.params.id, request.body, request.headers['idempotency-key']));
  api.post('/v1/guided-setups/:id/check', { preHandler, schema: { params, querystring: empty, body: GuidedSetupRevisionSchema } }, request =>
    options.service.check(principal(request), request.params.id, request.body));
  api.post('/v1/guided-setups/:id/package-bindings', { preHandler, schema: { params, querystring: empty, body: GuidedSetupRevisionSchema } }, request =>
    options.service.mapPackage(principal(request), request.params.id, request.body));
  api.post('/v1/guided-setups/:id/test', { preHandler, schema: { params, querystring: empty, headers: IdempotencyHeadersSchema, body: SetupTestInputSchema } }, request =>
    options.service.beginTest(principal(request), request.params.id, request.body, request.headers['idempotency-key']));
  api.post('/v1/guided-setups/:id/proof', { preHandler, schema: { params, querystring: empty, body: SetupProofInputSchema } }, request =>
    options.service.collectProof(principal(request), request.params.id, request.body));
  api.post('/v1/guided-setups/:id/activate', { preHandler, schema: { params, querystring: empty, headers: IdempotencyHeadersSchema, body: SetupActivateInputSchema } }, request =>
    options.service.activate(principal(request), request.params.id, request.body, request.headers['idempotency-key']));
  api.post('/v1/guided-setups/:id/reconcile', { preHandler, schema: { params, querystring: empty, body: GuidedSetupRevisionSchema } }, request =>
    options.service.reconcile(principal(request), request.params.id, request.body));
  api.post('/v1/guided-setups/:id/deactivate', { preHandler, schema: { params, querystring: empty, headers: IdempotencyHeadersSchema, body: SetupActivateInputSchema } }, request =>
    options.service.deactivate(principal(request), request.params.id, request.body, request.headers['idempotency-key']));
}
