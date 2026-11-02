import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {MediaCustodyRequestSchema,MediaCustodyResponseSchema,MediaCustodyRecordResponseSchema,MediaCustodyRetentionSchema,ProblemDetailsSchema} from '@jrc/contracts';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import {MediaCustodyError,type MediaCustodyService} from '../../modules/media-custody/service.js';
import {tenantOperationalProblem} from '../../modules/tenancy/operational-limits.js';
export interface MediaCustodyRouteOptions extends AuthenticationOptions {service:MediaCustodyService}
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerMediaCustodyRoutes(app:FastifyInstance,options:MediaCustodyRouteOptions){
 app.decorateRequest('authentication',null);
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.setErrorHandler((error,request,reply)=>{
  const operational=tenantOperationalProblem(error,request.id);if(operational)return reply.code(operational.status).type('application/problem+json').send(operational);
  const candidate=error as {code?:string;statusCode?:number;validation?:unknown;constraint?:string};
  if(error instanceof MediaCustodyError)return problem(reply,request,error.statusCode,error.code);
  if(candidate.code==='PARTNER_CREDENTIAL_REVOKED')return problem(reply,request,403,candidate.code);
  if(candidate.code==='23505')return problem(reply,request,409,'MEDIA_CUSTODY_CONFLICT');
  if(candidate.code==='42501')return problem(reply,request,403,'FORBIDDEN');
  if(candidate.code==='23514'||candidate.code==='23503')return problem(reply,request,409,'MEDIA_CUSTODY_REJECTED');
  if(candidate.validation||error instanceof z.ZodError)return problem(reply,request,400,'INVALID_REQUEST');
  if([400,413,415].includes(candidate.statusCode??0))return problem(reply,request,candidate.statusCode!,'INVALID_REQUEST');
  return problem(reply,request,500,'MEDIA_CUSTODY_UNAVAILABLE');
 });
 const preHandler=[authenticateRequest(options),async(request:FastifyRequest,reply:FastifyReply)=>{
  const principal=request.authentication;
  if(principal?.kind==='API_KEY'&&principal.scopes.includes('media:archive')&&!principal.scopes.some(scope=>scope.startsWith('chatwoot:')))return;
  return problem(reply,request,403,'FORBIDDEN');
 }];
 const api=app.withTypeProvider<ZodTypeProvider>(),empty=z.strictObject({}),params=z.strictObject({id:z.uuid()});
 const errors={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,409:ProblemDetailsSchema,413:ProblemDetailsSchema,415:ProblemDetailsSchema,429:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema};
 const principal=(request:FastifyRequest)=>{const value=request.authentication;if(value?.kind!=='API_KEY')throw new MediaCustodyError('FORBIDDEN',403);return value;};
 api.post('/v1/media-custody/receipts',{preHandler,schema:{tags:['Media custody'],summary:'Record client durable-storage attestation; never marks READY or deletes bytes',headers:z.object({'idempotency-key':z.uuid()}),querystring:empty,body:MediaCustodyRequestSchema,response:{201:MediaCustodyRecordResponseSchema,...errors}}},async(request,reply)=>{
  const p=principal(request);return reply.code(201).send(await options.service.record(p.organizationId,p.apiKeyId,request.body,request.headers['idempotency-key']));
 });
 api.get('/v1/media-custody/receipts/:id',{preHandler,schema:{tags:['Media custody'],summary:'Read a tenant custody receipt',params,querystring:empty,response:{200:MediaCustodyResponseSchema,...errors}}},request=>{const p=principal(request);return options.service.get(p.organizationId,p.apiKeyId,request.params.id);});
 api.get('/v1/media-custody/receipts/:id/retention',{preHandler,schema:{tags:['Media custody'],summary:'Evaluate KEEP policy without scheduling or performing deletion',params,querystring:empty,response:{200:MediaCustodyRetentionSchema,...errors}}},request=>{const p=principal(request);return options.service.evaluate(p.organizationId,p.apiKeyId,request.params.id);});
}
