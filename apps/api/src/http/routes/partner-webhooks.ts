import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {IdempotencyHeadersSchema,ProblemDetailsSchema} from '@jrc/contracts';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import {requirePermission} from '../plugins/authorization.js';
import {PartnerEventError,type PartnerEventService} from '../../modules/partner-events/service.js';
import {tenantOperationalProblem} from '../../modules/tenancy/operational-limits.js';

export interface PartnerWebhookRouteOptions extends AuthenticationOptions {service:PartnerEventService}
const empty=z.strictObject({}),params=z.strictObject({id:z.uuid()});
const limit=z.coerce.number().int().min(1).max(100).default(50);
const after=z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).refine(value=>BigInt(value)<=9223372036854775807n);
const EndpointSchema=z.strictObject({id:z.uuid(),url:z.url(),status:z.enum(['ACTIVE','REVOKED']),createdAt:z.iso.datetime(),revokedAt:z.iso.datetime().nullable()});
const EventSchema=z.strictObject({schemaVersion:z.literal(1),eventId:z.uuid(),cursor:z.string(),organizationId:z.uuid(),type:z.string().describe('message.received, message.created, message.status or connection.status'),occurredAt:z.iso.datetime(),data:z.record(z.string(),z.unknown())});
const DeliverySchema=z.strictObject({id:z.uuid(),endpointId:z.uuid(),eventId:z.uuid(),status:z.string().describe('PENDING, RUNNING, DELIVERED, FAILED or CANCELLED'),attempts:z.number().int().min(0).max(10),lastErrorCode:z.string().nullable(),availableAt:z.iso.datetime(),updatedAt:z.iso.datetime()});
const errors={400:ProblemDetailsSchema,401:ProblemDetailsSchema,403:ProblemDetailsSchema,404:ProblemDetailsSchema,409:ProblemDetailsSchema.extend({retentionDays:z.literal(30).optional(),earliestCursor:z.string().nullable().optional(),lastPrunedCursor:z.string().optional(),resetCursor:z.literal('0').optional()}),413:ProblemDetailsSchema,415:ProblemDetailsSchema,422:ProblemDetailsSchema,429:ProblemDetailsSchema,500:ProblemDetailsSchema,503:ProblemDetailsSchema};
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerPartnerWebhookRoutes(app:FastifyInstance,options:PartnerWebhookRouteOptions){
 app.decorateRequest('authentication',null);
 app.addHook('onRequest',async(_request,reply)=>{reply.header('Cache-Control','no-store');});
 app.setErrorHandler((error,request,reply)=>{
  const operational=tenantOperationalProblem(error,request.id);if(operational)return reply.code(operational.status).type('application/problem+json').send(operational);
  if(error instanceof PartnerEventError){
   if(error.cursorInfo)return reply.code(error.statusCode).type('application/problem+json').send({type:'about:blank',title:error.code,status:error.statusCode,code:error.code,requestId:request.id,...error.cursorInfo});
   return problem(reply,request,error.statusCode,error.code);
  }
  const candidate=error as {validation?:unknown;statusCode?:number};
  if(candidate.validation||error instanceof z.ZodError)return problem(reply,request,400,'INVALID_REQUEST');
  if(candidate.statusCode===400||candidate.statusCode===413||candidate.statusCode===415)return problem(reply,request,candidate.statusCode,'INVALID_REQUEST');
  return problem(reply,request,500,'PARTNER_EVENTS_UNAVAILABLE');
 });
 const preHandler=[authenticateRequest(options),requirePermission('webhooks:manage')];
 const api=app.withTypeProvider<ZodTypeProvider>(),org=(request:FastifyRequest)=>request.authentication!.organizationId;
 api.get('/v1/partner-webhooks',{preHandler,schema:{tags:['Partner webhooks'],summary:'List webhook endpoints without secrets',querystring:empty,response:{200:z.strictObject({data:z.array(EndpointSchema)}),...errors}}},request=>options.service.list(org(request)));
 api.post('/v1/partner-webhooks',{preHandler,schema:{tags:['Partner webhooks'],summary:'Create an HTTPS endpoint with its independent signing secret',headers:IdempotencyHeadersSchema,querystring:empty,body:z.strictObject({url:z.string().url().max(2048)}),response:{201:z.strictObject({endpoint:EndpointSchema,signingSecret:z.string(),replayed:z.boolean()}),...errors}}},async(request,reply)=>reply.code(201).send(await options.service.create(org(request),request.body,request.headers['idempotency-key'])));
 api.delete('/v1/partner-webhooks/:id',{preHandler,schema:{tags:['Partner webhooks'],summary:'Revoke endpoint and cancel pending deliveries',params,querystring:empty,response:{200:EndpointSchema,...errors}}},request=>options.service.revoke(org(request),request.params.id));
 api.get('/v1/partner-events',{preHandler,schema:{tags:['Partner webhooks'],summary:'Read events retained for 30 days; expired cursors return 409',querystring:z.strictObject({after:after.optional(),limit}),response:{200:z.strictObject({schemaVersion:z.literal(1),retentionDays:z.literal(30),earliestCursor:z.string().nullable(),lastPrunedCursor:z.string(),data:z.array(EventSchema),nextCursor:z.string()}),...errors}}},request=>options.service.events(org(request),request.query));
 api.get('/v1/partner-webhook-deliveries',{preHandler,schema:{tags:['Partner webhooks'],summary:'Inspect delivery status and bounded retry diagnostics',querystring:z.strictObject({limit}),response:{200:z.strictObject({data:z.array(DeliverySchema)}),...errors}}},request=>options.service.deliveries(org(request),request.query));
}
