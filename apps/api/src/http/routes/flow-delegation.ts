import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {SimulationInputSchema} from '../../modules/automations/simulation.js';
import {AutomationPublishedVersionV1Schema,IdempotencyHeadersSchema} from '@jrc/contracts';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import type {Role} from '../plugins/authorization.js';
import {AutomationError} from '../../modules/automations/service.js';
import {AttendanceError} from '../../modules/attendance/types.js';
import {IdempotencyConflictError} from '../../modules/instances/idempotency.js';
import {tenantOperationalProblem} from '../../modules/tenancy/operational-limits.js';
import {FlowDelegationError,type createFlowDelegationService,type FlowAccess,type BrokerPrincipal} from '../../modules/flows/delegation/service.js';
import * as c from '@jrc/contracts';
import {MediaError,SUPPORTED_UPLOAD_MIME_TYPES} from '@jrc/providers';
export interface FlowDelegationRouteOptions extends AuthenticationOptions {
 service:ReturnType<typeof createFlowDelegationService>;
 resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>;
 resolveFlowSession(digest:string):Promise<string|null>;
}
const empty=z.strictObject({}),params=z.strictObject({id:z.uuid()}),integrationParams=z.strictObject({integrationId:z.uuid()});
const safeCodes=new Set(['FLOW_ACCESS_DENIED','FLOW_CONTEXT_CHANGED','FLOW_SCOPE_CHANGED','FLOW_DEFINITION_NOT_FOUND','FLOW_PROFILE_CHANGED','FLOW_PROFILE_MIGRATION_REQUIRED','FLOW_GRANT_CHANGED','FLOW_SESSION_NOT_FOUND','FLOW_SESSION_NONCE_REUSED','FLOW_ORIGIN_CAPABILITY_REQUIRED','FLOW_ORIGIN_CAPABILITY_REVOKED','FLOW_HOST_ADAPTER_REQUIRED','FLOW_DEPENDENCY_LIMIT','FLOW_CREATE_REPLAY_UNAVAILABLE','FLOW_CUTOVER_CHANGED','FLOW_CUTOVER_RECONCILIATION_REQUIRED','FLOW_OWNER_CHANGED','FLOW_CENTRAL_CUTOVER_REQUIRED','CENTRAL_CALLBACK_TEST_REQUIRED','FLOW_TRANSPORT_UNSUPPORTED','FLOW_IDENTITY_CHANGED','FLOW_HOST_PROOF_INVALID','FLOW_HOST_UNAVAILABLE','FLOW_REMOTE_TIMEOUT']);
for(const code of ['FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED','FLOW_TARGET_LIMIT','FLOW_ACCOUNT_CLIENT_REQUIRED','FLOW_COMPETING_EXECUTOR','FLOW_CUTOVER_NOT_FOUND','FLOW_CUTOVER_OBSERVATION_FAILED','FLOW_CUTOVER_PROOF_INVALID','FLOW_CUTOVER_TIMEOUT','FLOW_INBOX_CHANGED','FLOW_INBOX_POLICY_UNSAFE','FLOW_QR_IDENTITY_UNVERIFIED','FLOW_QR_PROBE_REQUIRED','FLOW_HOST_AUTHORITY_UNAVAILABLE','FLOW_CREDENTIAL_NOT_FOUND'])safeCodes.add(code);
async function result<S extends z.ZodType>(schema:S,value:Promise<unknown>):Promise<z.output<S>>{const parsed=schema.safeParse(await value);if(!parsed.success)throw new Error('FLOW_INVALID_RESPONSE');return parsed.data;}
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerFlowDelegationRoutes(app:FastifyInstance,options:FlowDelegationRouteOptions){
 app.addHook('onRoute',route=>{route.bodyLimit??=16_384;});
 app.addHook('onSend',async(request,reply,payload)=>{
  const path=request.routeOptions.url??'',graph=path.startsWith('/v1/delegated-flows')&&(/\/(?:simulate|import-preview|publish|versions(?:-page)?|action-catalog|resource-channels|media)$/.test(path)||path==='/v1/delegated-flows'||path==='/v1/delegated-flows/:id');
  const limit=graph?2_200_000:16_384;
  if((typeof payload==='string'||Buffer.isBuffer(payload))&&Buffer.byteLength(payload)>limit){reply.code(502).type('application/problem+json');return JSON.stringify({type:'about:blank',title:'FLOW_RESPONSE_TOO_LARGE',status:502,code:'FLOW_RESPONSE_TOO_LARGE',requestId:request.id});}
  return payload;
 });
 app.addHook('onRequest',async(_request,reply)=>{reply.header('cache-control','no-store');});
 app.setErrorHandler((error,request,reply)=>{
  if((error as {code?:string}).code==='FST_ERR_CTP_BODY_TOO_LARGE')return problem(reply,request,413,'REQUEST_TOO_LARGE');
  const operational=tenantOperationalProblem(error,request.id);if(operational)return reply.code(operational.status).type('application/problem+json').send(operational);
  if(error instanceof FlowDelegationError&&safeCodes.has(error.code))return problem(reply,request,error.statusCode,error.code);
  if(error instanceof AutomationError||error instanceof AttendanceError)return problem(reply,request,error.statusCode,error.code);
  if(error instanceof IdempotencyConflictError)return problem(reply,request,409,error.code);
  if(error instanceof MediaError)return problem(reply,request,error.code==='MEDIA_SIZE_LIMIT'?413:422,error.code);
  const invalid=error instanceof z.ZodError||Boolean((error as {validation?:unknown}).validation);
  return problem(reply,request,invalid?400:500,invalid?'INVALID_REQUEST':'FLOW_UNAVAILABLE');
 });
 await app.register(async scope=>{
  scope.decorateRequest('authentication',null);scope.addHook('onRequest',authenticateRequest(options));
  const guard=(write:boolean)=>async(req:FastifyRequest,reply:FastifyReply)=>{
   const who=req.authentication,role=who?.kind==='JWT'?await options.resolveCurrentRole(who.actorId,who.organizationId):null;
   if(!role||!(write?['OWNER','ADMIN']:['OWNER','ADMIN','OPERATOR']).includes(role))return problem(reply,req,403,'FORBIDDEN');
   if(!write&&role==='OPERATOR'&&(req.body as {scopes?:string[]})?.scopes?.some(item=>item!=='flow:read'))return problem(reply,req,403,'FORBIDDEN');
  };
  const principal=(req:FastifyRequest):BrokerPrincipal=>{
   const who=req.authentication!;if(who.kind!=='JWT')throw new FlowDelegationError('FLOW_ACCESS_DENIED');
   const authVersion=who.authVersion;if(typeof authVersion!=='number'||!Number.isSafeInteger(authVersion)||authVersion<0)throw new FlowDelegationError('FLOW_ACCESS_DENIED');
   return {organizationId:who.organizationId,actorId:who.actorId,authVersion};
  };
  const api=scope.withTypeProvider<ZodTypeProvider>();
  api.get('/v1/flow-delegations/targets',{preHandler:[guard(false)],schema:{querystring:empty,response:{200:c.FlowTargetsSchema}}},req=>result(c.FlowTargetsSchema,options.service.availableTargets(principal(req))));
  api.post('/v1/flow-delegations/sessions',{preHandler:[guard(false)],schema:{querystring:empty,body:c.FlowBrokerSessionSchema,response:{201:c.FlowSessionResponseSchema}}},async(req,reply)=>reply.code(201).send(await options.service.issueBrokerSession(principal(req),req.body)));
  api.delete('/v1/flow-delegations/sessions/:id',{preHandler:[guard(true)],schema:{params,querystring:empty,response:{200:z.strictObject({revoked:z.literal(true)})}}},req=>result(z.strictObject({revoked:z.literal(true)}),options.service.revokeSession(principal(req),req.params.id)));
  api.post('/v1/flow-delegations/executor-profiles',{preHandler:[guard(true)],schema:{querystring:empty,body:c.FlowProfileInputSchema,response:{200:c.FlowProfileResponseSchema}}},req=>options.service.configureExecutorProfile(principal(req),req.body));
  api.put('/v1/flow-delegations/member-grants',{preHandler:[guard(true)],schema:{querystring:empty,body:c.FlowMemberGrantSchema,response:{200:z.strictObject({revision:z.number().int().positive()})}}},req=>options.service.setMemberGrant(principal(req),req.body));
 });
 await app.register(async scope=>{
  const accesses=new WeakMap<FastifyRequest,FlowAccess>();
  scope.addHook('onRequest',async(req,reply)=>{
   if(req.headers['x-organization-id']!==undefined||req.headers['x-jrc-organization-id']!==undefined)return problem(reply,req,400,'INVALID_REQUEST');
   const raw=req.headers.authorization,match=typeof raw==='string'?/^Bearer ([A-Za-z0-9_-]{43})$/.exec(raw):null;
   if(!match||req.headers['x-jrc-api-key']!==undefined)return problem(reply,req,401,'UNAUTHORIZED');
   const org=await options.resolveFlowSession(createHash('sha256').update(match[1]!).digest('hex'));
   if(!org)return problem(reply,req,401,'UNAUTHORIZED');
   accesses.set(req,{organizationId:z.uuid().parse(org),token:match[1]!});
  });
  const access=(req:FastifyRequest)=>accesses.get(req)!;
  const api=scope.withTypeProvider<ZodTypeProvider>(),base='/v1/delegated-flows';
  scope.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:16*1024*1024},(_request,body,done)=>done(null,body));
  api.post(base+'/:id/channels/:channelId/media',{bodyLimit:16*1024*1024,schema:{params:z.strictObject({id:z.uuid(),channelId:z.uuid()}),querystring:empty,headers:z.object({'content-type':z.literal('application/octet-stream'),'x-jrc-media-mime':z.enum(SUPPORTED_UPLOAD_MIME_TYPES),'x-jrc-media-kind':z.enum(['image','audio','video','document']),'x-jrc-media-name':z.string().min(1).max(765),'idempotency-key':z.uuid()}),response:{201:c.AutomationMediaAssetSchema}}},async(req,reply)=>{
   if(!Buffer.isBuffer(req.body)||!req.body.byteLength)throw new FlowDelegationError('FLOW_INVALID_REQUEST',400);
   let fileName:string;try{fileName=decodeURIComponent(req.headers['x-jrc-media-name']);}catch{throw new FlowDelegationError('FLOW_INVALID_REQUEST',400);}
   return reply.code(201).send(await options.service.uploadMedia(access(req),req.params.id,req.params.channelId,{bytes:req.body,mimeType:req.headers['x-jrc-media-mime'],kind:req.headers['x-jrc-media-kind'],fileName,idempotencyKey:req.headers['idempotency-key']}));
  });
  const catalogQuery=z.strictObject({pageSize:z.coerce.number().int().min(1).max(200).default(25),cursor:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional()});
  const catalogInput=(query:z.infer<typeof catalogQuery>)=>({pageSize:query.pageSize,...(query.cursor===undefined?{}:{cursor:query.cursor})});
  const actionParams=params.extend({channelId:z.uuid()}),assetParams=actionParams.extend({mediaId:z.uuid()});
  api.get(base+'/:id/resource-channels',{schema:{params,querystring:catalogQuery,response:{200:c.AutomationResourceChannelsSchema}}},req=>options.service.resourceChannels(access(req),req.params.id,catalogInput(req.query)));
  api.get(base+'/:id/channels/:channelId/action-catalog',{schema:{params:actionParams,querystring:catalogQuery,response:{200:c.ActionCatalogPageSchema}}},req=>options.service.actionCatalog(access(req),req.params.id,req.params.channelId,catalogInput(req.query)));
  api.post(base+'/:id/channels/:channelId/action-resources',{schema:{params:actionParams,querystring:empty,body:c.ActionResourceWriteSchema}},req=>options.service.saveActionResource(access(req),req.params.id,req.params.channelId,req.body));
  api.get(base+'/:id/channels/:channelId/media',{schema:{params:actionParams,querystring:empty}},req=>options.service.mediaCatalog(access(req),req.params.id,req.params.channelId));
  api.post(base+'/:id/channels/:channelId/media/:mediaId/revoke',{schema:{params:assetParams,querystring:empty,body:z.strictObject({revision:z.number().int().positive()})}},req=>options.service.revokeMedia(access(req),req.params.id,req.params.channelId,req.params.mediaId,req.body.revision));
  api.get(base+'/status',{schema:{querystring:empty}},req=>options.service.status(access(req)));
  api.get(base+'/nodes',{schema:{querystring:empty}},req=>options.service.nodes(access(req)));
  api.post(base+'/import-preview',{bodyLimit:2_200_000,schema:{querystring:empty,body:z.strictObject({source:z.enum(['AUTO','JRC','N8N','TYPEBOT']),content:z.string().max(2097152),integrationIds:z.array(z.uuid()).min(1).max(100)})}},req=>options.service.importPreview(access(req),req.body));
  api.post(base+'/:id/simulate',{bodyLimit:2_200_000,schema:{params,querystring:empty,body:SimulationInputSchema}},req=>options.service.simulate(access(req),req.params.id,req.body));
  api.get(base+'/:id/http-credentials',{schema:{params,querystring:catalogQuery}},req=>options.service.httpCredentialCatalog(access(req),req.params.id,catalogInput(req.query)));
  api.get(base+'/:id/subflow-catalog',{schema:{params,querystring:catalogQuery}},req=>options.service.subflowCatalog(access(req),req.params.id,catalogInput(req.query)));
  api.get(base+'/:id/ai-credentials',{schema:{params,querystring:catalogQuery}},req=>options.service.aiCredentialCatalog(access(req),req.params.id,catalogInput(req.query)));
  const catalogTarget=z.strictObject({id:z.uuid(),targetId:z.uuid()});
  api.get(base+'/:id/handoff-connections',{schema:{params,querystring:empty}},req=>options.service.handoffConnections(access(req),req.params.id));
  api.get(base+'/:id/local-handoff-channels',{schema:{params,querystring:empty}},req=>options.service.localHandoffChannels(access(req),req.params.id));
  api.get(base+'/:id/integrations/:targetId/attendance-catalog',{schema:{params:catalogTarget,querystring:empty}},req=>options.service.handoffCatalog(access(req),req.params.id,req.params.targetId));
  api.get(base+'/:id/channels/:targetId/local-attendance-catalog',{schema:{params:catalogTarget,querystring:empty}},req=>options.service.localHandoffCatalog(access(req),req.params.id,req.params.targetId));
  api.get(base+'/targets',{schema:{querystring:empty,response:{200:c.FlowTargetsSchema}}},req=>result(c.FlowTargetsSchema,options.service.targets(access(req))));
  api.get(base+'/:id/scope',{schema:{params,querystring:empty,response:{200:c.FlowDefinitionScopeSchema}}},req=>options.service.scope(access(req),req.params.id));
  api.get(base,{schema:{querystring:z.strictObject({pageSize:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional()}),response:{200:c.FlowListSchema}}},req=>options.service.list(access(req),req.query));
  api.post(base,{bodyLimit:2_200_000,schema:{headers:IdempotencyHeadersSchema,querystring:empty,body:c.FlowDraftCreateSchema,response:{201:c.FlowDefinitionSchema}}},async(req,reply)=>reply.code(201).send(await result(c.FlowDefinitionSchema,options.service.create(access(req),req.body,req.headers['idempotency-key']))));
  api.get(base+'/:id',{schema:{params,querystring:empty,response:{200:c.FlowDefinitionSchema}}},req=>result(c.FlowDefinitionSchema,options.service.get(access(req),req.params.id)));
  api.put(base+'/:id',{bodyLimit:2_200_000,schema:{params,querystring:empty,body:c.FlowDraftSaveSchema,response:{200:c.FlowDefinitionSchema}}},req=>result(c.FlowDefinitionSchema,options.service.save(access(req),req.params.id,req.body)));
  api.post(base+'/:id/publish',{schema:{params,querystring:empty,body:c.FlowPublishSchema,response:{200:AutomationPublishedVersionV1Schema}}},req=>options.service.publish(access(req),req.params.id,req.body));
  api.get(base+'/:id/versions',{schema:{params,querystring:empty,response:{200:c.FlowVersionsSchema}}},req=>options.service.versions(access(req),req.params.id));
  api.get(base+'/:id/versions-page',{schema:{params,querystring:z.strictObject({pageSize:z.coerce.number().int().min(1).max(1).default(1),cursor:z.string().regex(/^[1-9][0-9]{0,8}$/).optional()})}},req=>options.service.versionsPage(access(req),req.params.id,req.query));
  api.post(base+'/:id/validate',{schema:{params,querystring:empty,body:empty,response:{200:c.FlowValidationSchema}}},req=>options.service.validate(access(req),req.params.id));
  api.post(base+'/:id/bindings',{schema:{params,querystring:empty,body:c.FlowBindSchema,response:{201:c.FlowBindingSchema}}},async(req,reply)=>reply.code(201).send(await result(c.FlowBindingSchema,options.service.bind(access(req),req.params.id,req.body))));
  const cutover=base+'/integrations/:integrationId/cutover';
  api.get(cutover,{schema:{params:integrationParams,querystring:empty,response:{200:c.FlowCutoverStatusSchema}}},req=>result(c.FlowCutoverStatusSchema,options.service.getCutover(access(req),req.params.integrationId)));
  api.post(cutover+'/prepare',{schema:{params:integrationParams,querystring:empty,body:c.FlowCutoverPrepareSchema,response:{200:c.FlowCutoverResultSchema}}},req=>options.service.prepareCutover(access(req),req.params.integrationId,req.body));
  api.post(cutover+'/reconcile',{schema:{params:integrationParams,querystring:empty,body:c.FlowCutoverReconcileSchema,response:{200:c.FlowCutoverResultSchema}}},req=>options.service.reconcileCutover(access(req),req.params.integrationId,req.body));
 });
}
