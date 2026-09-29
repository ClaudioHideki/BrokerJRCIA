import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CreateSupportTicketSchema, ReplySupportTicketSchema, UpdateSupportTicketSchema, SupportTicketDetailSchema, SupportTicketListSchema } from '@jrc/contracts';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import { SupportError, type SupportActor, type SupportService } from '../../modules/support/service.js';
import { PlatformError } from '../../modules/platform/service.js';

export interface SupportRouteOptions extends AuthenticationOptions {
  service: SupportService;
  resolveCurrentRole(userId: string, organizationId: string): Promise<Role | null>;
}
const params = z.strictObject({ id: z.uuid() }), empty = z.strictObject({});
function errors(app: FastifyInstance) {
  app.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    if ((error as {constraint?:string}).constraint==='support_organization_writable') {
      return reply.code(409).type('application/problem+json').send({type:'about:blank',title:'SUPPORT_ORGANIZATION_DISABLED',code:'SUPPORT_ORGANIZATION_DISABLED',status:409,requestId:request.id});
    }
    const status = error instanceof SupportError || error instanceof PlatformError ? error.statusCode : error instanceof z.ZodError || (error as {validation?:unknown}).validation ? 400 : (error as {statusCode?:number}).statusCode===413 ? 413 : 500;
    const code = error instanceof SupportError || error instanceof PlatformError ? error.code : status===400 ? 'INVALID_REQUEST' : status===413 ? 'PAYLOAD_TOO_LARGE' : 'SUPPORT_UNAVAILABLE';
    return reply.code(status).type('application/problem+json').send({ type:'about:blank', title:code, code, status, requestId: request.id });
  });
}

export async function registerSupportRoutes(app: FastifyInstance, options: SupportRouteOptions) {
  errors(app); app.decorateRequest('authentication', null);
  const auth = authenticateRequest(options), api = app.withTypeProvider<ZodTypeProvider>();
  const actor = async (request: FastifyRequest, write = false): Promise<SupportActor> => {
    const identity = request.authentication;
    const role = identity?.kind==='JWT' ? await options.resolveCurrentRole(identity.actorId,identity.organizationId) : null;
    if (!role || identity?.kind!=='JWT' || (write && role==='VIEWER')) throw new SupportError('SUPPORT_FORBIDDEN',403);
    return {kind:'TENANT',organizationId:identity.organizationId,actorId:identity.actorId,canWrite:role!=='VIEWER'};
  };
  api.get('/v1/support/tickets',{preHandler:auth,schema:{querystring:z.strictObject({cursor:z.uuid().optional()}),response:{200:SupportTicketListSchema}}},async req=>options.service.list(await actor(req),req.query.cursor));
  api.post('/v1/support/tickets',{preHandler:auth,bodyLimit:65_536,schema:{querystring:empty,body:CreateSupportTicketSchema,response:{201:SupportTicketDetailSchema}}},async(req,reply)=>{const result=await options.service.create(await actor(req,true),req.body);return reply.code(201).send(result);});
  api.get('/v1/support/tickets/:id',{preHandler:auth,schema:{params,querystring:z.strictObject({before:z.uuid().optional()}),response:{200:SupportTicketDetailSchema}}},async req=>options.service.read(await actor(req),req.params.id,req.query.before));
  api.post('/v1/support/tickets/:id/replies',{preHandler:auth,bodyLimit:65_536,schema:{params,querystring:empty,body:ReplySupportTicketSchema,response:{200:SupportTicketDetailSchema}}},async req=>options.service.reply(await actor(req,true),req.params.id,req.body));
  api.patch('/v1/support/tickets/:id',{preHandler:auth,schema:{params,querystring:empty,body:UpdateSupportTicketSchema,response:{200:SupportTicketDetailSchema}}},async req=>options.service.update(await actor(req,true),req.params.id,req.body));
}

export async function registerPlatformSupportRoutes(app: FastifyInstance, options: {
  service: SupportService;
  authorize(request: FastifyRequest, write: boolean): Promise<SupportActor>;
}) {
  await app.register(async scope => {
    errors(scope); const api = scope.withTypeProvider<ZodTypeProvider>();
    api.get('/support/tickets',{schema:{querystring:z.strictObject({cursor:z.uuid().optional()}),response:{200:SupportTicketListSchema}}},async req=>options.service.list(await options.authorize(req,false),req.query.cursor));
    api.get('/support/tickets/:id',{schema:{params,querystring:z.strictObject({before:z.uuid().optional()}),response:{200:SupportTicketDetailSchema}}},async req=>options.service.read(await options.authorize(req,false),req.params.id,req.query.before));
    api.post('/support/tickets/:id/replies',{bodyLimit:65_536,schema:{params,querystring:empty,body:ReplySupportTicketSchema,response:{200:SupportTicketDetailSchema}}},async req=>options.service.reply(await options.authorize(req,true),req.params.id,req.body));
    api.patch('/support/tickets/:id',{schema:{params,querystring:empty,body:UpdateSupportTicketSchema,response:{200:SupportTicketDetailSchema}}},async req=>options.service.update(await options.authorize(req,true),req.params.id,req.body));
  });
}
