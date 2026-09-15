import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authenticateRequest,type AuthenticationOptions } from '../plugins/authentication.js';
import { registerRequestContext } from '../plugins/request-context.js';
import { InstanceWorkspaceService, WorkspaceError } from '../../modules/instances/workspace.js';
export interface InstanceWorkspaceRouteOptions extends AuthenticationOptions {service:InstanceWorkspaceService}
export const InstanceSettingsSchema=z.strictObject({rejectCall:z.boolean(),msgCall:z.string().max(2000),groupsIgnore:z.boolean(),alwaysOnline:z.boolean(),readMessages:z.boolean(),readStatus:z.boolean(),syncFullHistory:z.boolean()});
const WorkspaceSchema=z.object({observedAt:z.iso.datetime(),providerAvailable:z.boolean(),
  profile:z.object({name:z.string().nullable(),phone:z.string().nullable(),state:z.string().nullable()}),
  counts:z.object({contacts:z.number().int().nonnegative().nullable(),chats:z.number().int().nonnegative().nullable(),messages:z.number().int().nonnegative().nullable()}),
  settings:InstanceSettingsSchema.nullable(),instance:z.object({id:z.uuid(),name:z.string(),status:z.string(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()}),
  operations:z.array(z.object({id:z.uuid(),type:z.string(),status:z.string(),attempts:z.number().int().nonnegative(),errorCode:z.string().nullable(),updatedAt:z.iso.datetime()}))});
export async function registerInstanceWorkspaceRoutes(app:FastifyInstance,options:InstanceWorkspaceRouteOptions){
  app.decorateRequest('authentication',null);
  await registerRequestContext(app,{timeoutMs:12_000});
  app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
  app.setErrorHandler((error,request,reply)=>{
    const status=error instanceof WorkspaceError?error.status:(error as {validation?:unknown}).validation?400:500;
    return reply.code(status).send({status,code:error instanceof WorkspaceError?error.code:status===400?'INVALID_REQUEST':'INTERNAL_ERROR',requestId:request.id});
  });
  const schema={params:z.strictObject({id:z.uuid()}),querystring:z.strictObject({})};
  app.withTypeProvider<ZodTypeProvider>().get('/v1/instances/:id/workspace',{schema:{...schema,response:{200:WorkspaceSchema,403:z.object({status:z.number(),code:z.string()})}},preHandler:authenticateRequest(options)},async(request,reply)=>{
    const auth=request.authentication;if(auth?.kind!=='JWT')return reply.code(403).send({status:403,code:'FORBIDDEN'});
    return options.service.read({...auth,requestId:request.id,signal:request.operationSignal,deadline:request.operationDeadline},request.params.id);
  });
  app.withTypeProvider<ZodTypeProvider>().put('/v1/instances/:id/settings',{schema:{...schema,body:InstanceSettingsSchema,response:{200:z.object({ok:z.literal(true)}),403:z.object({status:z.number(),code:z.string()})}},preHandler:authenticateRequest(options)},async(request,reply)=>{
    const auth=request.authentication;if(auth?.kind!=='JWT')return reply.code(403).send({status:403,code:'FORBIDDEN'});
    return options.service.update({...auth,requestId:request.id,signal:request.operationSignal,deadline:request.operationDeadline},request.params.id,request.body);
  });
}
