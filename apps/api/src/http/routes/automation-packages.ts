import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AUTOMATION_PACKAGE_MAX_BYTES, AutomationPackageSchema, IdempotencyHeadersSchema } from '@jrc/contracts';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import { AutomationError } from '../../modules/automations/errors.js';
import { IdempotencyConflictError } from '../../modules/instances/idempotency.js';
import type { AutomationPackageService } from '../../modules/automation-integrations/package-service.js';

export interface AutomationPackageRouteOptions extends AuthenticationOptions {
  service: AutomationPackageService;
  resolveCurrentRole(userId: string, organizationId: string): Promise<Role | null>;
}
const problem = (reply: FastifyReply, request: FastifyRequest, status: number, code: string) =>
  reply.code(status).type('application/problem+json').send({ type: 'about:blank', title: code, code, status, requestId: request.id });
export async function registerAutomationPackageRoutes(app: FastifyInstance, options: AutomationPackageRouteOptions) {
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const candidate = typeof error === 'object' && error !== null
      ? error as { validation?: unknown; statusCode?: number; message?: string } : {};
    if (error instanceof AutomationError) return problem(reply, request, error.statusCode, error.code);
    if (error instanceof IdempotencyConflictError) return problem(reply, request, error.status, error.code);
    if (error instanceof z.ZodError || candidate.validation) return problem(reply, request, 400, 'AUTOMATION_PACKAGE_INVALID');
    if (candidate.statusCode === 413) return problem(reply, request, 413, 'AUTOMATION_PACKAGE_SIZE_LIMIT');
    if (candidate.message && /^AUTOMATION_PACKAGE_[A-Z_]+$/u.test(candidate.message)) return problem(reply, request, 422, candidate.message);
    return problem(reply, request, 503, 'AUTOMATION_PACKAGE_UNAVAILABLE');
  });
  const authentication = authenticateRequest(options);
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.authentication;
    const role = identity?.kind === 'JWT' ? await options.resolveCurrentRole(identity.actorId, identity.organizationId) : null;
    if (!role || !['OWNER', 'ADMIN'].includes(role)) return problem(reply, request, 403, 'FORBIDDEN');
  };
  const api = app.withTypeProvider<ZodTypeProvider>(), preHandler = [authentication, guard];
  const empty = z.strictObject({}), params = z.strictObject({ id: z.uuid() });
  api.post('/v1/automation-packages/preview', { bodyLimit: AUTOMATION_PACKAGE_MAX_BYTES, preHandler,
    schema: { querystring: empty, body: AutomationPackageSchema } }, request => options.service.preview(request.authentication!.organizationId, request.body));
  api.post('/v1/automation-packages', { bodyLimit: AUTOMATION_PACKAGE_MAX_BYTES, preHandler,
    schema: { headers: IdempotencyHeadersSchema, querystring: empty, body: AutomationPackageSchema } }, async (request, reply) =>
    reply.code(201).send(await options.service.import(request.authentication!.organizationId, request.body, request.headers['idempotency-key'])));
  api.get('/v1/automation-packages/:id', { preHandler, schema: { params, querystring: empty } }, request =>
    options.service.get(request.authentication!.organizationId, request.params.id));
  api.post('/v1/automation-packages/:id/publish', { preHandler,
    schema: { params, querystring: empty, headers: IdempotencyHeadersSchema, body: z.strictObject({ revision: z.int().positive() }) } }, request =>
    options.service.publish(request.authentication!.organizationId, request.params.id, request.body.revision, request.headers['idempotency-key']));
  api.get('/v1/automations/:id/package', { preHandler,
    schema: { params, querystring: z.strictObject({ version: z.coerce.number().int().positive() }) } }, request =>
    options.service.export(request.authentication!.organizationId, request.params.id, request.query.version));
}
