import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AUTOMATION_NODE_CATALOG_V1, AutomationGraphV1Schema, IdempotencyHeadersSchema } from '@jrc/contracts';
import {tenantOperationalProblem} from '../../modules/tenancy/operational-limits.js';
import { z } from 'zod';
import type { Role } from '../plugins/authorization.js';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import { AutomationError, type AutomationService, type createExecutionService } from '../../modules/automations/service.js';
import type { LegacyFlowMigrationService } from '../../modules/automations/legacy-migration.js';

export interface AutomationRouteOptions extends AuthenticationOptions {
  service:AutomationService;executions:ReturnType<typeof createExecutionService>;migration?:LegacyFlowMigrationService;
  resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>;
}
const empty=z.strictObject({}),params=z.strictObject({id:z.uuid()}),bindingParams=z.strictObject({id:z.uuid(),bindingId:z.uuid()});
const draft=z.strictObject({name:z.string().trim().min(1).max(120),graph:AutomationGraphV1Schema});
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string,details:string[]=[])=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,details,requestId:request.id});
export async function registerAutomationRoutes(app:FastifyInstance,options:AutomationRouteOptions){
  app.decorateRequest('authentication',null);app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
  app.setErrorHandler((error,request,reply)=>{const operational=tenantOperationalProblem(error,request.id);if(operational)return reply.code(operational.status).type('application/problem+json').send(operational);if(error instanceof AutomationError)return problem(reply,request,error.statusCode,error.code,error.details);
    const candidate=error as {validation?:unknown;statusCode?:number};const status=candidate.validation||error instanceof z.ZodError?400:candidate.statusCode===413?413:500;return problem(reply,request,status,status===400?'INVALID_REQUEST':'AUTOMATION_UNAVAILABLE');});
  const auth=authenticateRequest(options),guard=(write:boolean)=>async(request:FastifyRequest,reply:FastifyReply)=>{const identity=request.authentication;
    const role=identity?.kind==='JWT'?await options.resolveCurrentRole(identity.actorId,identity.organizationId):null;
    if(!role||(write&&!['OWNER','ADMIN'].includes(role)))return problem(reply,request,403,'FORBIDDEN');};
  const read=[auth,guard(false)],write=[auth,guard(true)],api=app.withTypeProvider<ZodTypeProvider>();
  const org=(request:FastifyRequest)=>request.authentication!.organizationId;
  api.get('/v1/automations/status',{preHandler:read,schema:{querystring:empty}},()=>options.service.status());
  api.get('/v1/automation-nodes',{preHandler:read,schema:{querystring:empty}},()=>({schemaVersion:1,data:AUTOMATION_NODE_CATALOG_V1}));
  api.get('/v1/automations',{preHandler:read,schema:{querystring:empty}},request=>options.service.list(org(request)));
  if(options.migration){const migration=options.migration;
   api.get('/v1/automations/migrations/legacy',{preHandler:read,schema:{querystring:empty}},request=>migration.status(org(request)));
   api.post('/v1/automations/migrations/legacy',{preHandler:write,schema:{headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({limit:z.number().int().min(1).max(200).default(50),afterId:z.uuid().optional()})}},request=>migration.migrateBatch(org(request),{limit:request.body.limit,...(request.body.afterId?{afterId:request.body.afterId}:{}),actorId:request.authentication!.actorId!}));
   api.post('/v1/automations/migrations/legacy/:id/cutover',{preHandler:write,schema:{params,headers:IdempotencyHeadersSchema,querystring:empty,body:empty}},request=>migration.cutover(org(request),request.params.id,request.authentication!.actorId!));
   api.post('/v1/automations/migrations/legacy/:id/rollback',{preHandler:write,schema:{params,headers:IdempotencyHeadersSchema,querystring:empty,body:empty}},request=>migration.rollback(org(request),request.params.id,request.authentication!.actorId!));
  }
  api.post('/v1/automations',{preHandler:write,schema:{headers:IdempotencyHeadersSchema,querystring:empty,body:draft}},async(request,reply)=>reply.code(201).send(await options.service.create(org(request),request.body)));
  api.get('/v1/automations/:id',{preHandler:read,schema:{params,querystring:empty}},request=>options.service.get(org(request),request.params.id));
  api.put('/v1/automations/:id',{preHandler:write,schema:{params,querystring:empty,body:draft.extend({revision:z.number().int().positive()})}},request=>options.service.save(org(request),request.params.id,request.body));
  api.post('/v1/automations/:id/validate',{preHandler:read,schema:{params,querystring:empty,body:empty}},request=>options.service.validate(org(request),request.params.id));
  api.post('/v1/automations/:id/simulate',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({text:z.string().max(4096)})}},request=>options.service.simulate(org(request),request.params.id,request.body));
  api.post('/v1/automations/:id/publish',{preHandler:write,schema:{params,headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({revision:z.number().int().positive()})}},request=>options.service.publish(org(request),request.params.id,request.body.revision));
  api.post('/v1/automations/:id/archive',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({archived:z.boolean()})}},request=>options.service.setArchived(org(request),request.params.id,request.body.archived,request.authentication!.actorId!));
  api.get('/v1/automations/:id/versions',{preHandler:read,schema:{params,querystring:empty}},request=>options.service.versions(org(request),request.params.id));
  api.get('/v1/automations/:id/bindings',{preHandler:read,schema:{params,querystring:empty}},request=>options.service.bindings(org(request),request.params.id));
  api.post('/v1/automations/:id/bindings',{preHandler:write,schema:{params,headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({channelId:z.uuid(),version:z.number().int().positive().optional(),humanDestinationId:z.uuid().nullable().optional()})}},async(request,reply)=>reply.code(201).send(await options.service.bind(org(request),request.params.id,{channelId:request.body.channelId,...(request.body.version===undefined?{}:{version:request.body.version}),...(request.body.humanDestinationId===undefined?{}:{humanDestinationId:request.body.humanDestinationId})})));
  api.patch('/v1/automations/:id/bindings/:bindingId',{preHandler:write,schema:{params:bindingParams,querystring:empty,body:z.strictObject({status:z.enum(['ACTIVE','PAUSED','DISABLED']),revision:z.number().int().positive()})}},request=>options.service.setBindingStatus(org(request),request.params.bindingId,request.body,request.params.id));
  api.get('/v1/executions',{preHandler:read,schema:{querystring:z.strictObject({automationId:z.uuid().optional()})}},request=>options.executions.list(org(request),request.query.automationId));
  api.get('/v1/executions/:id',{preHandler:read,schema:{params,querystring:empty}},request=>options.executions.get(org(request),request.params.id));
  api.post('/v1/executions/:id/cancel',{preHandler:write,schema:{params,querystring:empty,body:empty}},request=>options.executions.cancel(org(request),request.params.id));
  api.post('/v1/executions/:id/retry',{preHandler:write,schema:{params,headers:IdempotencyHeadersSchema,querystring:empty,body:empty}},request=>options.executions.retry(org(request),request.params.id));
  api.post('/v1/executions/:id/reconcile',{preHandler:write,schema:{params,headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({outboxId:z.uuid(),outcome:z.enum(['CONFIRMED_SENT','CONFIRMED_NOT_SENT','UNRESOLVED']),evidenceCode:z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/),providerReference:z.string().max(300).optional()})}},request=>options.executions.reconcile(org(request),request.params.id,request.authentication!.actorId!,{outboxId:request.body.outboxId,outcome:request.body.outcome,evidenceCode:request.body.evidenceCode,...(request.body.providerReference===undefined?{}:{providerReference:request.body.providerReference})}));
  api.post('/v1/executions/:id/resume',{preHandler:write,schema:{params,headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({eventKey:z.string().min(1).max(300),text:z.string().max(4096).default('')})}},request=>options.executions.resume(org(request),request.params.id,request.body.eventKey,{text:request.body.text,eventType:'RESUME'}));
}
