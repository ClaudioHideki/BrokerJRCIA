import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {IdempotencyHeadersSchema} from '@jrc/contracts';
import type {Role} from '../plugins/authorization.js';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import type {AutomationImporter} from '../../modules/automation-integrations/importer.js';
export interface AutomationImportRouteOptions extends AuthenticationOptions{service:AutomationImporter;resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>}
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerAutomationImportRoutes(app:FastifyInstance,options:AutomationImportRouteOptions){app.decorateRequest('authentication',null);app.addHook('onRequest',async(_request,reply)=>reply.header('Cache-Control','no-store'));app.setErrorHandler((error,request,reply)=>problem(reply,request,error instanceof SyntaxError||error instanceof z.ZodError?400:422,error instanceof SyntaxError?'AUTOMATION_IMPORT_JSON_INVALID':error instanceof Error?error.message:'AUTOMATION_IMPORT_FAILED'));
 const auth=authenticateRequest(options),guard=async(request:FastifyRequest,reply:FastifyReply)=>{const identity=request.authentication,role=identity?.kind==='JWT'?await options.resolveCurrentRole(identity.actorId,identity.organizationId):null;if(!role||!['OWNER','ADMIN'].includes(role))return problem(reply,request,403,'FORBIDDEN');},api=app.withTypeProvider<ZodTypeProvider>();
 api.post('/v1/automation-imports',{preHandler:[auth,guard],schema:{headers:IdempotencyHeadersSchema,querystring:z.strictObject({}),body:z.strictObject({source:z.enum(['JRC','N8N','TYPEBOT']),content:z.string().min(2).max(2_000_000),formatVersion:z.string().max(80).optional()})}},async(request,reply)=>reply.code(201).send(await options.service.import(request.authentication!.organizationId,{source:request.body.source,content:request.body.content,...(request.body.formatVersion?{formatVersion:request.body.formatVersion}:{})})));
}
