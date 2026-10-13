import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  UpdateWhatsAppGroupSelectionSchema, WhatsAppGroupCatalogPageQuerySchema,
  WhatsAppGroupCatalogPageSchema,
  WhatsAppGroupEventsConfigurationSchema,
  ConfigureWhatsAppGroupAutomationSchema,WhatsAppGroupAutomationActionSchema,
  WhatsAppGroupAutomationQuerySchema,WhatsAppGroupAutomationViewSchema,
  AbandonQrDispatchAttemptRequestSchema,AbandonQrOutboundObservationRequestSchema,
} from '@jrc/contracts';
import { GroupCatalogError, type createWhatsAppGroupCatalog } from '../../modules/whatsapp-groups/service.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import type { createWhatsAppGroupWebhookConfiguration } from '../../modules/whatsapp-groups/webhook-configuration.js';
import {GroupRuntimeError,type createGroupAutomationRuntime} from '../../modules/whatsapp-groups/automation-runtime.js';
import {AttendanceError} from '../../modules/attendance/types.js';

export interface WhatsAppGroupsRouteOptions extends AuthenticationOptions {
  service: ReturnType<typeof createWhatsAppGroupCatalog>;
  resolveCurrentRole(userId: string, organizationId: string): Promise<Role | null>;
  configuration?:ReturnType<typeof createWhatsAppGroupWebhookConfiguration>;
  automation?:Pick<ReturnType<typeof createGroupAutomationRuntime>,'inspect'|'configure'|'pause'|'resume'|'abandonAttempt'|'abandonObservation'>;
}

const publicErrorCodes = new Set([
  'INVALID_REQUEST', 'GROUP_ACCESS_DENIED', 'GROUP_CHANNEL_NOT_FOUND', 'GROUP_CHANNEL_DISCONNECTED',
  'GROUP_CATALOG_NOT_READY', 'GROUP_CATALOG_CHANGED', 'GROUP_CATALOG_REFRESHING', 'GROUP_CATALOG_STALE',
  'GROUP_IDENTITY_CHANGED', 'GROUP_REFRESH_LEASE_LOST', 'GROUP_NOT_IN_CATALOG',
  'PROVIDER_ABORTED', 'PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_FAILED', 'PROVIDER_INVALID_RESPONSE',
  'GROUP_WEBHOOK_UNKNOWN','GROUP_WEBHOOK_UNAVAILABLE','GROUP_WEBHOOK_REFRESHING',
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
    if(error instanceof GroupRuntimeError){
      const codes=new Set(['GROUP_INVALID','GROUP_TRIGGER_INVALID','GROUP_ACCESS_DENIED','GROUP_RUNTIME_UNAVAILABLE',
        'GROUP_TRANSPORT_IGNORED','GROUP_IDENTITY_CHANGED','GROUP_WEBHOOK_CHANGED','GROUP_AUTHORITY_CHANGED',
        'GROUP_NODE_UNSUPPORTED','GROUP_CONTROL_CHANGED','GROUP_SESSION_ACTIVE','GROUP_WORKSPACE_CHANGED',
        'GROUP_CHANNEL_UNAVAILABLE','GROUP_OUTCOME_UNKNOWN','GROUP_NOT_ENABLED','GROUP_ATTEMPT_NOT_FOUND','GROUP_OBSERVATION_NOT_FOUND']);
      if(codes.has(error.code))return problem(reply,request,error.code==='GROUP_ACCESS_DENIED'?403:
        ['GROUP_INVALID','GROUP_TRIGGER_INVALID'].includes(error.code)?400:error.code.endsWith('_NOT_FOUND')?404:409,error.code);
    }
    if(error instanceof AttendanceError&&['FORBIDDEN','QR_ATTEMPT_NOT_FOUND','QR_ATTEMPT_CHANGED','QR_OBSERVATION_NOT_FOUND','QR_OBSERVATION_CHANGED','QR_DISPATCH_STILL_ACTIVE','QR_ATTEMPTS_CHANGED'].includes(error.code))
      return problem(reply,request,error.statusCode,error.code);
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
  if(options.automation){
    const service=options.automation,response={200:WhatsAppGroupAutomationViewSchema};
    api.get('/v1/channels/:id/whatsapp-group-automation',{
      preHandler:[memberGuard(false)],schema:{params,querystring:WhatsAppGroupAutomationQuerySchema,response},
    },request=>service.inspect(principal(request),request.params.id,request.query.groupJid));
    api.put('/v1/channels/:id/whatsapp-group-automation',{
      preHandler:[memberGuard(true)],schema:{params,querystring:empty,body:ConfigureWhatsAppGroupAutomationSchema,response},
    },async request=>{await service.configure(principal(request),request.params.id,request.body);
      return service.inspect(principal(request),request.params.id,request.body.groupJid);});
    api.post('/v1/channels/:id/whatsapp-group-automation/pause',{
      preHandler:[memberGuard(true)],schema:{params,querystring:empty,body:WhatsAppGroupAutomationActionSchema,response},
    },async request=>{await service.pause(principal(request),request.params.id,request.body.groupJid,request.body.expectedRevision);
      return service.inspect(principal(request),request.params.id,request.body.groupJid);});
    api.post('/v1/channels/:id/whatsapp-group-automation/resume',{
      preHandler:[memberGuard(true)],schema:{params,querystring:empty,body:WhatsAppGroupAutomationActionSchema,response},
    },async request=>{await service.resume(principal(request),request.params.id,request.body.groupJid,request.body.expectedRevision);
      return service.inspect(principal(request),request.params.id,request.body.groupJid);});
    api.post('/v1/channels/:id/whatsapp-group-automation/dispatch-attempts/:attemptId/abandon',{
      preHandler:[memberGuard(true)],schema:{params:params.extend({attemptId:z.uuid()}),querystring:empty,
        body:AbandonQrDispatchAttemptRequestSchema.extend({groupJid:WhatsAppGroupAutomationQuerySchema.shape.groupJid}),response},
    },async request=>{const{groupJid,...input}=request.body;await service.abandonAttempt(principal(request),request.params.id,groupJid,request.params.attemptId,input);
      return service.inspect(principal(request),request.params.id,groupJid);});
    api.post('/v1/channels/:id/whatsapp-group-automation/observations/:observationId/abandon',{
      preHandler:[memberGuard(true)],schema:{params:params.extend({observationId:z.uuid()}),querystring:empty,
        body:AbandonQrOutboundObservationRequestSchema.extend({groupJid:WhatsAppGroupAutomationQuerySchema.shape.groupJid}),response},
    },async request=>{const{groupJid,...input}=request.body;await service.abandonObservation(principal(request),request.params.id,groupJid,request.params.observationId,input);
      return service.inspect(principal(request),request.params.id,groupJid);});
  }
  if(options.configuration)api.get('/v1/channels/:id/whatsapp-group-events-configuration',{
    preHandler:[memberGuard(false)],schema:{params,querystring:empty,response:{200:WhatsAppGroupEventsConfigurationSchema}},
  },request=>options.configuration!.status(principal(request),request.params.id));
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
