import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Role } from '../plugins/authorization.js';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { ObservabilityService } from '../../modules/observability/service.js';

export interface ObservabilityRouteOptions extends AuthenticationOptions {service:ObservabilityService;resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>}
export async function registerObservabilityRoutes(app:FastifyInstance,options:ObservabilityRouteOptions){
 app.decorateRequest('authentication',null);app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 const auth=authenticateRequest(options),guard=async(request:FastifyRequest,reply:FastifyReply)=>{const identity=request.authentication,role=identity?.kind==='JWT'?await options.resolveCurrentRole(identity.actorId,identity.organizationId):null;if(!role)return reply.code(403).send({type:'about:blank',title:'FORBIDDEN',status:403,code:'FORBIDDEN',requestId:request.id});};
 app.withTypeProvider<ZodTypeProvider>().get('/v1/operations/health',{preHandler:[auth,guard],schema:{querystring:z.strictObject({})}},request=>options.service.health(request.authentication!.organizationId));
}
