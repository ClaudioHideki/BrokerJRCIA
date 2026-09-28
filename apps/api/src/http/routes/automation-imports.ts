import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {IdempotencyHeadersSchema} from '@jrc/contracts';
import type {Role} from '../plugins/authorization.js';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import type {AutomationImporter} from '../../modules/automation-integrations/importer.js';
import {AutomationError} from '../../modules/automations/service.js';
import {IdempotencyConflictError} from '../../modules/instances/idempotency.js';
export interface AutomationImportRouteOptions extends AuthenticationOptions{service:AutomationImporter;resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>}
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerAutomationImportRoutes(app:FastifyInstance,options:AutomationImportRouteOptions){app.decorateRequest('authentication',null);app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});app.setErrorHandler((error,request,reply)=>{
  if(error instanceof AutomationError)return problem(reply,request,error.statusCode,error.code);
  if(error instanceof IdempotencyConflictError)return problem(reply,request,409,error.code);
  if(error instanceof SyntaxError)return problem(reply,request,400,'AUTOMATION_IMPORT_JSON_INVALID');
  if(error instanceof z.ZodError || (typeof error==='object'&&error!==null&&'validation' in error))return problem(reply,request,400,'AUTOMATION_IMPORT_INVALID');
  return problem(reply,request,500,'AUTOMATION_IMPORT_FAILED');
 });
 const auth=authenticateRequest(options),guard=async(request:FastifyRequest,reply:FastifyReply)=>{const identity=request.authentication,role=identity?.kind==='JWT'?await options.resolveCurrentRole(identity.actorId,identity.organizationId):null;if(!role||!['OWNER','ADMIN'].includes(role))return problem(reply,request,403,'FORBIDDEN');},api=app.withTypeProvider<ZodTypeProvider>();
 const body=z.strictObject({source:z.enum(['AUTO','JRC','N8N','TYPEBOT']).default('AUTO'),content:z.string().min(2).max(2_000_000),formatVersion:z.string().max(80).optional()}),empty=z.strictObject({});
 api.post('/v1/automation-imports/preview',{bodyLimit:2_100_000,preHandler:[auth,guard],schema:{querystring:empty,body}},request=>options.service.preview(request.authentication!.organizationId,{source:request.body.source,content:request.body.content,...(request.body.formatVersion?{formatVersion:request.body.formatVersion}:{})}));
 api.post('/v1/automation-imports',{bodyLimit:2_100_000,preHandler:[auth,guard],schema:{headers:IdempotencyHeadersSchema,querystring:empty,body}},async(request,reply)=>reply.code(201).send(await options.service.import(request.authentication!.organizationId,{source:request.body.source,content:request.body.content,...(request.body.formatVersion?{formatVersion:request.body.formatVersion}:{})},request.headers['idempotency-key'])));
}
