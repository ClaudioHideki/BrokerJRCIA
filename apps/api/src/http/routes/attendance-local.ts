import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LocalAttendanceChannelsSchema } from '@jrc/contracts';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import { AttendanceError } from '../../modules/attendance/types.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import type { createLocalAttendanceCatalog } from '../../modules/attendance/local-catalog.js';

export interface AttendanceLocalRouteOptions extends AuthenticationOptions {
  service: ReturnType<typeof createLocalAttendanceCatalog>;
  resolveCurrentRole(user: string, org: string): Promise<Role | null>;
}

export async function registerAttendanceLocalRoutes(app: FastifyInstance, options: AttendanceLocalRouteOptions) {
  const problem = (reply: FastifyReply, request: FastifyRequest, status: number, code: string) =>
    reply.code(status).type('application/problem+json').send({type: 'about:blank', title: code, status, code, requestId: request.id});
  app.decorateRequest('authentication', null);
  app.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const operational = tenantOperationalProblem(error, request.id);
    if (operational) return reply.code(operational.status).type('application/problem+json').send(operational);
    if (error instanceof AttendanceError) return problem(reply, request, error.statusCode, error.code);
    const invalid = (error as {validation?: unknown}).validation || error instanceof z.ZodError;
    return problem(reply, request, invalid ? 400 : 500, invalid ? 'INVALID_REQUEST' : 'ATTENDANCE_CATALOG_UNAVAILABLE');
  });
  app.addHook('onRequest', authenticateRequest(options));
  const guard = async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.authentication;
    const role = identity?.kind === 'JWT' ? await options.resolveCurrentRole(identity.actorId, identity.organizationId) : null;
    if (!role || !['OWNER', 'ADMIN'].includes(role)) return problem(reply, request, 403, 'FORBIDDEN');
  };
  app.withTypeProvider<ZodTypeProvider>().get('/v1/attendance/local-channels', {
    preHandler: [guard], schema: {querystring: z.strictObject({}), response: {200: LocalAttendanceChannelsSchema}},
  }, async request => ({data: await options.service.listChannels(request.authentication!.organizationId)}));
}
