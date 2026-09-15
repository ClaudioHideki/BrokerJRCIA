import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import type {Role} from '../plugins/authorization.js';
import type {createMetaOnboardingService} from '../../modules/meta-onboarding/service.js';
import {tenantOperationalProblem} from '../../modules/tenancy/operational-limits.js';
export interface MetaOnboardingRouteOptions extends AuthenticationOptions {
 service:ReturnType<typeof createMetaOnboardingService>;
 resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>;
}
export async function registerMetaOnboardingRoutes(app:FastifyInstance,options:MetaOnboardingRouteOptions) {
 app.decorateRequest('authentication',null);
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.setErrorHandler((error,request,reply)=>{
  const operational=tenantOperationalProblem(error,request.id);
  if(operational) return reply.code(operational.status).type('application/problem+json').send(operational);
  const e=error as {status?:number;validation?:unknown};const status=e.validation?400:[404,409,503].includes(e.status??0)?e.status!:500;
  reply.code(status).send({type:'about:blank',title:'Meta onboarding unavailable',status,code:'META_ONBOARDING_UNAVAILABLE',requestId:request.id});
 });
 app.addHook('preHandler',authenticateRequest(options));
 app.addHook('preHandler',async(request,reply)=>{
  const auth=request.authentication;
  const role=auth?.kind==='JWT'?await options.resolveCurrentRole(auth.actorId,auth.organizationId):null;
  if(role!=='OWNER'&&role!=='ADMIN') return reply.code(403).send({status:403,code:'FORBIDDEN'});
 });
 const api=app.withTypeProvider<ZodTypeProvider>();const empty=z.strictObject({});
 api.get('/v1/meta-onboarding',{schema:{querystring:empty}},request=>options.service.list(request.authentication!.organizationId));
 api.post('/v1/meta-onboarding/start',{schema:{body:empty,querystring:empty}},request=>options.service.start(request.authentication!.organizationId,request.authentication!.actorId!));
 api.post('/v1/meta-onboarding/complete',{schema:{querystring:empty,body:z.strictObject({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),code:z.string().min(1).max(4096),wabaId:z.string().regex(/^\d{5,64}$/),phoneNumberId:z.string().regex(/^\d{5,64}$/)})}},request=>options.service.complete(request.authentication!.organizationId,request.authentication!.actorId!,request.body));
 api.post('/v1/meta-onboarding/:id/revoke',{schema:{body:empty,querystring:empty,params:z.strictObject({id:z.uuid()})}},request=>options.service.revoke(request.authentication!.organizationId,request.params.id));
 api.post('/v1/meta-onboarding/:id/refresh',{schema:{body:empty,querystring:empty,params:z.strictObject({id:z.uuid()})}},request=>options.service.refresh(request.authentication!.organizationId,request.params.id));
 api.post('/v1/meta-onboarding/:id/register',{schema:{body:z.strictObject({pin:z.string().regex(/^\d{6}$/)}),querystring:empty,params:z.strictObject({id:z.uuid()})}},request=>options.service.refresh(request.authentication!.organizationId,request.params.id,request.body.pin));
}
