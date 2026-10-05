import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ResumeAttendanceRequestSchema,ResumeOperationViewSchema,AttendanceResumeContextSchema,IdempotencyHeadersSchema } from '@jrc/contracts';
import { authenticateRequest,type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import { AttendanceError } from '../../modules/attendance/types.js';
import { tenantOperationalProblem } from '../../modules/tenancy/operational-limits.js';
import type { createAttendanceResumeService } from '../../modules/attendance/resume-service.js';
export interface AttendanceResumeRouteOptions extends AuthenticationOptions {
  service:ReturnType<typeof createAttendanceResumeService>;resolveCurrentRole(user:string,org:string):Promise<Role|null>;
}
export async function registerAttendanceResumeRoutes(app:FastifyInstance,options:AttendanceResumeRouteOptions){
  const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
  app.decorateRequest('authentication',null);app.addHook('onRequest',async(_request,reply)=>{reply.header('cache-control','no-store');});
  app.setErrorHandler((error,request,reply)=>{
    const operational=tenantOperationalProblem(error,request.id);if(operational)return reply.code(operational.status).type('application/problem+json').send(operational);
    if(error instanceof AttendanceError)return problem(reply,request,error.statusCode,error.code);
    const invalid=(error as {validation?:unknown}).validation||error instanceof z.ZodError;
    return problem(reply,request,invalid?400:500,invalid?'INVALID_REQUEST':'ATTENDANCE_RESUME_UNAVAILABLE');
  });
  const auth=authenticateRequest(options),guard=async(request:FastifyRequest,reply:FastifyReply)=>{
    const identity=request.authentication,role=identity?.kind==='JWT'?await options.resolveCurrentRole(identity.actorId,identity.organizationId):null;
    if(!role||!['OWNER','ADMIN'].includes(role))return problem(reply,request,403,'FORBIDDEN');
  };
  app.addHook('onRequest',auth);
  const api=app.withTypeProvider<ZodTypeProvider>(),params=z.strictObject({id:z.uuid()}),empty=z.strictObject({}),preHandler=[guard];
  api.post('/v1/attendance/conversations/:id/resume',{preHandler,schema:{params,querystring:empty,headers:IdempotencyHeadersSchema,body:ResumeAttendanceRequestSchema,response:{202:ResumeOperationViewSchema}}},
    async(request,reply)=>reply.code(202).send(await options.service.requestAttendanceResume(request.authentication!.organizationId,request.authentication!.actorId!,request.headers['idempotency-key'],{...request.body,conversationId:request.params.id})));
  api.get('/v1/attendance/resume-operations/:id',{preHandler,schema:{params,querystring:empty,response:{200:ResumeOperationViewSchema}}},request=>options.service.getOperation(request.authentication!.organizationId,request.params.id));
  api.get('/v1/attendance/conversations/:id/resume-context',{preHandler,schema:{params,querystring:empty,response:{200:AttendanceResumeContextSchema}}},request=>options.service.getContext(request.authentication!.organizationId,request.params.id));
}
