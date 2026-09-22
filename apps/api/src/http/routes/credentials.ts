import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdempotencyHeadersSchema } from '@jrc/contracts';
import type { Role } from '../plugins/authorization.js';
import { authenticateRequest,type AuthenticationOptions } from '../plugins/authentication.js';
import { CredentialError,CredentialTypeSchema,type CredentialService } from '../../modules/automation-integrations/credentials.js';

export interface CredentialRouteOptions extends AuthenticationOptions {service:CredentialService;resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>}
const empty=z.strictObject({}),params=z.strictObject({id:z.uuid()}),secret=z.record(z.string(),z.unknown()).refine(value=>Object.keys(value).length>0,'Secret is required'),metadata=z.record(z.string(),z.unknown()).default({});
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerCredentialRoutes(app:FastifyInstance,options:CredentialRouteOptions){
 app.decorateRequest('authentication',null);app.addHook('onRequest',async(_request,reply)=>reply.header('Cache-Control','no-store'));
 app.setErrorHandler((error,request,reply)=>{if(error instanceof CredentialError)return problem(reply,request,error.statusCode,error.code);const candidate=error as {validation?:unknown};return problem(reply,request,candidate.validation||error instanceof z.ZodError?400:500,candidate.validation?'INVALID_REQUEST':'CREDENTIAL_UNAVAILABLE');});
 const auth=authenticateRequest(options),guard=(write:boolean)=>async(request:FastifyRequest,reply:FastifyReply)=>{const identity=request.authentication,role=identity?.kind==='JWT'?await options.resolveCurrentRole(identity.actorId,identity.organizationId):null;if(!role||(write&&!['OWNER','ADMIN'].includes(role)))return problem(reply,request,403,'FORBIDDEN');};
 const read=[auth,guard(false)],write=[auth,guard(true)],api=app.withTypeProvider<ZodTypeProvider>(),org=(request:FastifyRequest)=>request.authentication!.organizationId;
 api.get('/v1/credentials',{preHandler:read,schema:{querystring:empty}},request=>options.service.list(org(request)));
 api.post('/v1/credentials',{preHandler:write,schema:{headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({name:z.string().trim().min(1).max(120),type:CredentialTypeSchema,secret,metadata})}},async(request,reply)=>reply.code(201).send(await options.service.create(org(request),request.body)));
 api.get('/v1/credentials/:id',{preHandler:read,schema:{params,querystring:empty}},request=>options.service.get(org(request),request.params.id));
 api.put('/v1/credentials/:id',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({revision:z.number().int().positive(),secret})}},request=>options.service.rotate(org(request),request.params.id,request.body));
 api.delete('/v1/credentials/:id',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({revision:z.number().int().positive()})}},request=>options.service.revoke(org(request),request.params.id,request.body.revision));
 api.post('/v1/credentials/:id/test',{preHandler:write,schema:{params,querystring:empty,body:empty}},request=>options.service.test(org(request),request.params.id));
}
