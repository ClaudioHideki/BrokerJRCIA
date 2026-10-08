import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  UpdateWhatsAppGroupSelectionSchema, WhatsAppGroupCatalogPageQuerySchema,
  WhatsAppGroupCatalogPageSchema,
} from '@jrc/contracts';
import { GroupCatalogError, type createWhatsAppGroupCatalog } from '../../modules/whatsapp-groups/service.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';

export interface WhatsAppGroupsRouteOptions extends AuthenticationOptions {
  service: ReturnType<typeof createWhatsAppGroupCatalog>;
  resolveCurrentRole(userId: string, organizationId: string): Promise<Role | null>;
}

const publicErrorCodes = new Set([
  'INVALID_REQUEST', 'GROUP_ACCESS_DENIED', 'GROUP_CHANNEL_NOT_FOUND', 'GROUP_CHANNEL_DISCONNECTED',
  'GROUP_CATALOG_NOT_READY', 'GROUP_CATALOG_CHANGED', 'GROUP_CATALOG_REFRESHING', 'GROUP_CATALOG_STALE',
  'GROUP_IDENTITY_CHANGED', 'GROUP_REFRESH_LEASE_LOST', 'GROUP_NOT_IN_CATALOG',
  'PROVIDER_ABORTED', 'PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_FAILED', 'PROVIDER_INVALID_RESPONSE',
]);

function decodeCursor(value: string) {
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error('Noncanonical cursor');
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return WhatsAppGroupCatalogPageQuerySchema.parse({ cursor: decoded }).cursor!;
  } catch {
    throw new GroupCatalogError('INVALID_REQUEST', 400);
  }
}

export async function registerWhatsAppGroupsRoutes(app: FastifyInstance, options: WhatsAppGroupsRouteOptions) {
  const problem = (reply: FastifyReply, request: FastifyRequest, status: number, code: string) =>
    reply.code(status).type('application/problem+json').send({
      type: 'about:blank', title: code, status, code, requestId: request.id,
    });
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const operational = tenantOperationalProblem(error, request.id);
    if (operational) return reply.code(operational.status).type('application/problem+json').send(operational);
    if (error instanceof GroupCatalogError && publicErrorCodes.has(error.code)
      && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
      return problem(reply, request, error.status, error.code);
    }
    const invalid = error instanceof z.ZodError || Boolean((error as { validation?: unknown }).validation);
    return problem(reply, request, invalid ? 400 : 500, invalid ? 'INVALID_REQUEST' : 'GROUP_CATALOG_UNAVAILABLE');
  });
  app.addHook('onRequest', authenticateRequest(options));
  const memberGuard = (write: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.authentication;
    const role = identity?.kind === 'JWT'
      ? await options.resolveCurrentRole(identity.actorId, identity.organizationId) : null;
    if (!role || !(write ? ['OWNER', 'ADMIN'] : ['OWNER', 'ADMIN', 'OPERATOR']).includes(role)) {
      return problem(reply, request, 403, 'FORBIDDEN');
    }
  };
  const principal = (request: FastifyRequest) => ({
    organizationId: request.authentication!.organizationId, actorId: request.authentication!.actorId!,
  });
  const api = app.withTypeProvider<ZodTypeProvider>();
  const params = z.strictObject({ id: z.uuid() }), empty = z.strictObject({});
  const pageQuery = z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/u).optional(),
  });
  const response = { 200: WhatsAppGroupCatalogPageSchema };
  api.get('/v1/channels/:id/whatsapp-groups', {
    preHandler: [memberGuard(false)], schema: { params, querystring: pageQuery, response },
  }, request => options.service.page(principal(request), request.params.id, {
    limit: request.query.limit, ...(request.query.cursor ? { cursor: decodeCursor(request.query.cursor) } : {}),
  }));
  api.post('/v1/channels/:id/whatsapp-groups/refresh', {
    preHandler: [memberGuard(true)], schema: { params, querystring: empty, body: empty, response },
  }, request => options.service.refresh(principal(request), request.params.id));
  api.put('/v1/channels/:id/whatsapp-groups/selection', {
    preHandler: [memberGuard(true)], schema: { params, querystring: empty, body: UpdateWhatsAppGroupSelectionSchema, response },
  }, request => options.service.select(principal(request), request.params.id, request.body));
}
