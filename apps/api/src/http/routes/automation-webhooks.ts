import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {IdempotencyHeadersSchema} from '@jrc/contracts';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import type {Role} from '../plugins/authorization.js';
import type {createWebhookService} from '../../modules/automation-integrations/webhooks.js';

export interface AutomationWebhookRouteOptions extends AuthenticationOptions{service:ReturnType<typeof createWebhookService>;resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>}
const empty=z.strictObject({}),params=z.strictObject({id:z.uuid()}),hookParams=z.strictObject({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}),payload=z.record(z.string(),z.unknown());
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerAutomationWebhookRoutes(app:FastifyInstance,options:AutomationWebhookRouteOptions){app.decorateRequest('authentication',null);app.addHook('onRequest',async(_request,reply)=>reply.header('Cache-Control','no-store'));app.setErrorHandler((error,request,reply)=>{const code=error instanceof Error?error.message:'WEBHOOK_UNAVAILABLE',status=code==='WEBHOOK_NOT_FOUND'?404:code==='WEBHOOK_SIGNATURE_INVALID'?401:(error as {validation?:unknown}).validation?400:500;return problem(reply,request,status,status===500?'WEBHOOK_UNAVAILABLE':code);});
 const auth=authenticateRequest(options),guard=async(request:FastifyRequest,reply:FastifyReply)=>{const identity=request.authentication,role=identity?.kind==='JWT'?await options.resolveCurrentRole(identity.actorId,identity.organizationId):null;if(!role||!['OWNER','ADMIN'].includes(role))return problem(reply,request,403,'FORBIDDEN');},write=[auth,guard],api=app.withTypeProvider<ZodTypeProvider>(),org=(request:FastifyRequest)=>request.authentication!.organizationId;
 api.get('/v1/webhooks',{preHandler:write,schema:{querystring:empty}},request=>options.service.list(org(request)));
 api.post('/v1/webhooks',{preHandler:write,schema:{headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({bindingId:z.uuid(),hmacCredentialId:z.uuid().optional()})}},async(request,reply)=>reply.code(201).send(await options.service.create(org(request),{bindingId:request.body.bindingId,...(request.body.hmacCredentialId?{hmacCredentialId:request.body.hmacCredentialId}:{})})));
 api.delete('/v1/webhooks/:id',{preHandler:write,schema:{params,querystring:empty}},request=>options.service.revoke(org(request),request.params.id));
 api.post('/hooks/:token',{bodyLimit:256*1024,schema:{params:hookParams,querystring:empty,body:payload,headers:z.object({'x-jrc-event-id':z.string().min(8).max(200),'x-jrc-timestamp':z.string().optional(),'x-jrc-signature':z.string().optional()}).passthrough()}},async(request,reply)=>reply.code(202).send(await options.service.receive(request.params.token,request.headers['x-jrc-event-id'],request.body,request.headers['x-jrc-timestamp'],request.headers['x-jrc-signature'])));
}
