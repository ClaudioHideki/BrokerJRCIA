import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LocalAttendanceChannelsSchema,LocalAttendanceDirectorySchema,LocalTeamsViewSchema,LocalTeamViewSchema,
 LocalTeamCreateSchema,LocalTeamUpdateSchema,LocalTeamMembersSchema,LocalQueueSchema,LocalQueueItemSchema,LocalAssignmentRequestSchema } from '@jrc/contracts';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import { AttendanceError } from '../../modules/attendance/types.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import type { createLocalAttendanceCatalog } from '../../modules/attendance/local-catalog.js';
import type { createLocalAttendanceDirectoryService } from '../../modules/attendance/local-directory-service.js';

export interface AttendanceLocalRouteOptions extends AuthenticationOptions {
  service: ReturnType<typeof createLocalAttendanceCatalog>;
  directory?: ReturnType<typeof createLocalAttendanceDirectoryService>;
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
  const memberGuard = (admin=true) => async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.authentication;
    const role = identity?.kind === 'JWT' ? await options.resolveCurrentRole(identity.actorId, identity.organizationId) : null;
    if (!role || !(admin?['OWNER', 'ADMIN']:['OWNER','ADMIN','OPERATOR']).includes(role)) return problem(reply, request, 403, 'FORBIDDEN');
  };
  const guard=memberGuard();
  app.withTypeProvider<ZodTypeProvider>().get('/v1/attendance/local-channels', {
    preHandler: [guard], schema: {querystring: z.strictObject({}), response: {200: LocalAttendanceChannelsSchema}},
  }, async request => ({data: await options.service.listChannels(request.authentication!.organizationId)}));
  if(!options.directory)return;
  const directory=options.directory,api=app.withTypeProvider<ZodTypeProvider>(),empty=z.strictObject({}),teamParams=z.strictObject({teamId:z.uuid()}),channelParams=z.strictObject({channelId:z.uuid()});
  const preHandler=[guard],operatorHandler=[memberGuard(false)];
  api.get('/v1/attendance/local-teams',{preHandler,schema:{querystring:empty,response:{200:LocalTeamsViewSchema}}},
   request=>directory.listTeams(request.authentication!.organizationId,request.authentication!.actorId!));
  api.post('/v1/attendance/local-teams',{preHandler,schema:{querystring:empty,body:LocalTeamCreateSchema,response:{201:LocalTeamViewSchema}}},
   async(request,reply)=>reply.code(201).send(await directory.createTeam(request.authentication!.organizationId,request.authentication!.actorId!,request.body)));
  api.put('/v1/attendance/local-teams/:teamId',{preHandler,schema:{params:teamParams,querystring:empty,body:LocalTeamUpdateSchema,response:{200:LocalTeamViewSchema}}},
   request=>directory.updateTeam(request.authentication!.organizationId,request.authentication!.actorId!,request.params.teamId,request.body));
  api.put('/v1/attendance/local-teams/:teamId/members',{preHandler,schema:{params:teamParams,querystring:empty,body:LocalTeamMembersSchema,response:{200:LocalTeamViewSchema}}},
   request=>directory.replaceMembers(request.authentication!.organizationId,request.authentication!.actorId!,request.params.teamId,request.body));
  api.get('/v1/attendance/local-channels/:channelId/catalog',{preHandler,schema:{params:channelParams,querystring:empty,response:{200:LocalAttendanceDirectorySchema}}},
   request=>directory.catalog(request.authentication!.organizationId,request.authentication!.actorId!,request.params.channelId));
  api.get('/v1/attendance/local-channels/:channelId/queue',{preHandler:operatorHandler,schema:{params:channelParams,querystring:empty,response:{200:LocalQueueSchema}}},
   request=>directory.queue(request.authentication!.organizationId,request.authentication!.actorId!,request.params.channelId));
  api.post('/v1/attendance/local-conversations/:conversationId/assignment',{preHandler:operatorHandler,schema:{params:z.strictObject({conversationId:z.uuid()}),querystring:empty,body:LocalAssignmentRequestSchema,response:{200:LocalQueueItemSchema}}},
   request=>directory.assign(request.authentication!.organizationId,request.authentication!.actorId!,request.params.conversationId,request.body));
}
