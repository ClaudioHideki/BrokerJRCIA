import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {authenticateRequest,type AuthenticationOptions} from '../plugins/authentication.js';
import type {Role} from '../plugins/authorization.js';
import {tenantOperationalProblem} from '../../modules/tenancy/operational-limits.js';
import {AutomationError} from '../../modules/automations/service.js';
import {createFlowDelegationService,FlowDelegationError,type FlowAccess,type BrokerPrincipal} from '../../modules/flows/delegation/service.js';
import {FlowSessionCreateSchema} from '@jrc/contracts';
import {FlowScopesSchema,FlowSessionResponseSchema} from '@jrc/contracts';
import {createNativeRateLimit,NativeRateLimitError,type NativeRateLimitOptions} from '../../modules/flows/delegation/native-rate-limit.js';
import {NativeContextQuerySchema,NativeContextResponseSchema} from '../../modules/flows/delegation/native-context.js';
import {RegistrationChallengeCreateSchema,RegistrationCompleteSchema,type createNativeRegistrationService} from '../../modules/flows/delegation/registration/service.js';
import {RegistrationTupleSchema,OpaqueFlowSecret} from '../../modules/flows/delegation/registration/core.js';
import {InstallationIssueSchema,InstallationClaimSchema,InstallationRenewSchema,InstallationRevokeSchema} from '../../modules/flows/delegation/installation/contracts.js';
import {installationReductionDigest,type createNativeInstallationService} from '../../modules/flows/delegation/installation/service.js';
import {NativeReopenProofRequestSchema,NativeReopenProofResponseSchema,type createNativeReopenProof} from '../../modules/flows/delegation/broker-reopen-proof.js';
export const NativeCredentialCreateSchema=z.strictObject({scopes:FlowScopesSchema,expiresInSeconds:z.number().int().min(60).max(86400)});
export const NativeSessionRevokeSchema=z.strictObject({externalActorId:z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/),nonce:z.uuid()});
export interface NativeFlowRouteOptions extends AuthenticationOptions {
 service:ReturnType<typeof createFlowDelegationService>;
 resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>;
 resolveFlowCredential(digest:string):Promise<string|null>;
 rateLimit:NativeRateLimitOptions;
 registration?:ReturnType<typeof createNativeRegistrationService>;
 installation?:ReturnType<typeof createNativeInstallationService>;
 resolveInstallationGrant?:(digest:string)=>Promise<string|null>;
 resolveInstallationReduction?:(digest:string)=>Promise<string|null>;
 reopenProof?:ReturnType<typeof createNativeReopenProof>;
}
const empty=z.strictObject({}),params=z.strictObject({id:z.uuid()}),revoked=z.strictObject({revoked:z.literal(true)});
const safe=new Set(['INVALID_REQUEST','FLOW_ACCESS_DENIED','FLOW_CONTEXT_CHANGED','FLOW_SESSION_NOT_FOUND','FLOW_SESSION_NONCE_REUSED','FLOW_CREDENTIAL_NOT_FOUND','FLOW_HOST_AUTHORITY_UNAVAILABLE','FLOW_HOST_ADAPTER_REQUIRED','FLOW_ORIGIN_NATIVE_EVIDENCE_REQUIRED','FLOW_ORIGIN_CAPABILITY_REQUIRED','FLOW_ORIGIN_CAPABILITY_REVOKED']);
for(const code of ['FLOW_REGISTRATION_CHALLENGE_NOT_FOUND','FLOW_REGISTRATION_NOT_FOUND','FLOW_REGISTRATION_CHALLENGE_CONSUMED','FLOW_REGISTRATION_IN_PROGRESS','FLOW_REGISTRATION_HOST_UNAVAILABLE','FLOW_REGISTRATION_HOST_AUTHORITY_DENIED','FLOW_REGISTRATION_KEY_AUDIENCE_INVALID'])safe.add(code);
for(const code of ['FLOW_INSTALLATION_DENIED','FLOW_INSTALLATION_NOT_FOUND','FLOW_INSTALLATION_IN_PROGRESS','FLOW_INSTALLATION_REPLAY_CHANGED','FLOW_INSTALLATION_RECOVERY_EXPIRED','FLOW_INSTALLATION_ALREADY_CLAIMED','FLOW_INSTALLATION_HOST_UNAVAILABLE','FLOW_INSTALLATION_AUDIENCE_INVALID','FLOW_INSTALLATION_OPERATION_EXPIRED','FLOW_INSTALLATION_RENEW_TOO_EARLY'])safe.add(code);
const registrationHandle=z.strictObject({id:z.uuid(),revision:z.number().int().positive(),expiresAt:z.iso.datetime()});
const registrationCreated=registrationHandle.extend({challengeId:z.uuid()});
const challengeCreated=z.strictObject({challengeId:z.uuid(),transferNonce:OpaqueFlowSecret,expiresAt:z.iso.datetime(),context:RegistrationTupleSchema});
const challengeRead=z.strictObject({challengeId:z.uuid(),expiresAt:z.iso.datetime(),state:z.enum(['PENDING','VERIFYING','COMMITTED']),context:RegistrationTupleSchema,registration:registrationHandle.nullable()});
const problem=(reply:FastifyReply,request:FastifyRequest,status:number,code:string)=>reply.code(status).type('application/problem+json').send({type:'about:blank',title:code,status,code,requestId:request.id});
export async function registerNativeFlowRoutes(app:FastifyInstance,options:NativeFlowRouteOptions){
 app.addHook('onSend',async(request,reply,payload)=>{
  const path=request.routeOptions.url??'',limit=path.includes('native-registration')?65_536:16_384;
  if((typeof payload==='string'||Buffer.isBuffer(payload))&&Buffer.byteLength(payload)>limit){reply.code(502).type('application/problem+json');return JSON.stringify({type:'about:blank',title:'FLOW_RESPONSE_TOO_LARGE',status:502,code:'FLOW_RESPONSE_TOO_LARGE',requestId:request.id});}
  return payload;
 });
 const limit=createNativeRateLimit(options.rateLimit);
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('cache-control','no-store').header('pragma','no-cache');
  if(request.headers['x-organization-id']!==undefined||request.headers['x-jrc-organization-id']!==undefined)return problem(reply,request,400,'INVALID_REQUEST');
  if(request.headers['x-jrc-api-key']!==undefined)return problem(reply,request,401,'UNAUTHORIZED');
  await limit.ip(request);
 });
 app.setErrorHandler((error,request,reply)=>{
  if((error as {code?:string}).code==='FST_ERR_CTP_BODY_TOO_LARGE')return problem(reply,request,413,'REQUEST_TOO_LARGE');
  if(error instanceof NativeRateLimitError)return problem(reply.header('retry-after',String(error.retryAfter)),request,error.statusCode,error.code);
  const operational=tenantOperationalProblem(error,request.id);if(operational)return reply.code(operational.status).type('application/problem+json').send(operational);
  if(error instanceof FlowDelegationError&&safe.has(error.code))return problem(reply,request,error.statusCode,error.code);
  if(error instanceof AutomationError)return problem(reply,request,error.statusCode,error.code);
  if((error as {code?:string}).code==='FLOW_REOPEN_PROOF_REQUIRED'&&(error as {statusCode?:number}).statusCode===409)return problem(reply,request,409,'FLOW_REOPEN_PROOF_REQUIRED');
  const invalid=error instanceof z.ZodError||Boolean((error as {validation?:unknown}).validation);
  return problem(reply,request,invalid?400:500,invalid?'INVALID_REQUEST':'FLOW_UNAVAILABLE');
 });
 await app.register(async scope=>{
  scope.decorateRequest('authentication',null);scope.addHook('onRequest',authenticateRequest(options));
  const principal=(request:FastifyRequest):BrokerPrincipal=>{
   const auth=request.authentication;if(auth?.kind!=='JWT'||typeof auth.authVersion!=='number'||!Number.isSafeInteger(auth.authVersion)||auth.authVersion<0)throw new FlowDelegationError('FLOW_ACCESS_DENIED');
   return {organizationId:auth.organizationId,actorId:auth.actorId,authVersion:auth.authVersion};
  };
  const guard=async(request:FastifyRequest,reply:FastifyReply)=>{
   const actor=principal(request),role=await options.resolveCurrentRole(actor.actorId,actor.organizationId);
   if(role!=='OWNER'&&role!=='ADMIN')return problem(reply,request,403,'FORBIDDEN');
   await limit.identity(request,actor.organizationId,actor.actorId,actor.actorId);
  };
  const api=scope.withTypeProvider<ZodTypeProvider>();
  if(options.installation){const installation=options.installation;
   api.post('/v1/flow-delegations/native-installation-grants',{bodyLimit:16384,preHandler:[guard],schema:{querystring:empty,body:InstallationIssueSchema}},async(request,reply)=>reply.code(201).send(await installation.issue(principal(request),request.body)));
   api.delete('/v1/flow-delegations/native-installation-grants/:id',{bodyLimit:16384,preHandler:[guard],schema:{params,querystring:empty}},async request=>{if(request.body!==undefined)empty.parse(request.body);return installation.revokeAdministrative(principal(request),request.params.id);});
  }
  if(options.registration){const registration=options.registration;
   api.post('/v1/flow-delegations/native-registration-challenges',{bodyLimit:65536,preHandler:[guard],schema:{querystring:empty,body:RegistrationChallengeCreateSchema,response:{201:challengeCreated}}},async(request,reply)=>reply.code(201).send(challengeCreated.parse(await registration.issue(principal(request),request.body))));
   api.delete('/v1/flow-delegations/native-registration-challenges/:id',{bodyLimit:65536,preHandler:[guard],schema:{params,querystring:empty,response:{200:revoked}}},async request=>{if(request.body!==undefined)empty.parse(request.body);return revoked.parse(await registration.cancel(principal(request),request.params.id));});
   api.delete('/v1/flow-delegations/native-registrations/:id',{bodyLimit:65536,preHandler:[guard],schema:{params,querystring:empty,response:{200:revoked}}},async request=>{if(request.body!==undefined)empty.parse(request.body);return revoked.parse(await registration.revoke(principal(request),request.params.id));});
  }
  api.post('/v1/flow-delegations/native-credentials',{bodyLimit:16384,preHandler:[guard],schema:{querystring:empty,body:NativeCredentialCreateSchema,response:{201:FlowSessionResponseSchema}}},async(request,reply)=>reply.code(201).send(FlowSessionResponseSchema.parse(await options.service.issueNativeCredential(principal(request),request.body))));
  api.delete('/v1/flow-delegations/native-credentials/:id',{bodyLimit:16384,preHandler:[guard],schema:{params,querystring:empty,response:{200:revoked}}},async request=>{
   if(request.headers['content-length']&&request.headers['content-length']!=='0'||request.headers['transfer-encoding'])empty.parse(request.body);
   return revoked.parse(await options.service.revokeNativeCredential(principal(request),request.params.id));
  });
 });
 await app.register(async scope=>{
  const accesses=new WeakMap<FastifyRequest,FlowAccess>(),digests=new WeakMap<FastifyRequest,string>();
  scope.addHook('onRequest',async(request,reply)=>{
   const value=request.headers.authorization,match=typeof value==='string'?/^Bearer ([A-Za-z0-9_-]{43})$/.exec(value):null;
   if(!match)return problem(reply,request,401,'UNAUTHORIZED');
   const digest=createHash('sha256').update(match[1]!).digest('hex'),org=await options.resolveFlowCredential(digest);
   if(!org)return problem(reply,request,401,'UNAUTHORIZED');
   accesses.set(request,{organizationId:z.uuid().parse(org),token:match[1]!});digests.set(request,digest);
  });
  const guard=async(request:FastifyRequest)=>{const access=accesses.get(request)!;await limit.identity(request,access.organizationId,digests.get(request)!,(request.body as {externalActorId?:string}|undefined)?.externalActorId??'credential-context');};
  const api=scope.withTypeProvider<ZodTypeProvider>();
  if(options.reopenProof){const proof=options.reopenProof;api.post('/v1/flow-delegations/native-cutovers/:id/reopen-proof',{bodyLimit:16384,preHandler:[guard],schema:{params,querystring:empty,body:NativeReopenProofRequestSchema,response:{200:NativeReopenProofResponseSchema}}},request=>proof.observe(accesses.get(request)!,request.params.id,request.body));}
  if(options.installation){const installation=options.installation;api.post('/v1/flow-delegations/native-installation-grants/:id/claim',{bodyLimit:16384,preHandler:[guard],schema:{params,querystring:empty,body:InstallationClaimSchema}},async(request,reply)=>reply.code(201).send(await installation.claim(accesses.get(request)!,request.params.id,request.body)));}
  if(options.registration){const registration=options.registration;
   const nonce=(request:FastifyRequest)=>OpaqueFlowSecret.parse(request.headers['x-jrc-flow-challenge']);
   api.get('/v1/flow-delegations/native-registration-challenges/:id',{bodyLimit:65536,preHandler:[guard],schema:{params,querystring:empty,response:{200:challengeRead}}},async(request,reply)=>{if(request.body!==undefined)return problem(reply,request,400,'INVALID_REQUEST');return challengeRead.parse(await registration.read(accesses.get(request)!,request.params.id,nonce(request)));});
   api.post('/v1/flow-delegations/native-registrations',{bodyLimit:65536,preHandler:[guard],schema:{querystring:empty,body:RegistrationCompleteSchema,response:{201:registrationCreated}}},async(request,reply)=>reply.code(201).send(registrationCreated.parse(await registration.complete(accesses.get(request)!,nonce(request),request.body))));
  }
  api.get('/v1/flow-delegations/native-context',{bodyLimit:16384,preHandler:[guard],schema:{querystring:NativeContextQuerySchema,response:{200:NativeContextResponseSchema}}},async(request,reply)=>{
   if(request.body!==undefined||request.headers['transfer-encoding']||request.headers['content-length']&&request.headers['content-length']!=='0')return problem(reply,request,400,'INVALID_REQUEST');
   return NativeContextResponseSchema.parse(await options.service.nativeContext(accesses.get(request)!,request.query));
  });
  api.post('/v1/flow-delegations/native-sessions',{bodyLimit:16384,preHandler:[guard],schema:{querystring:empty,body:FlowSessionCreateSchema,response:{201:FlowSessionResponseSchema}}},async(request,reply)=>reply.code(201).send(FlowSessionResponseSchema.parse(await options.service.issueNativeSession(accesses.get(request)!,request.body))));
  api.delete('/v1/flow-delegations/native-sessions/:id',{bodyLimit:16384,preHandler:[guard],schema:{params,querystring:empty,body:NativeSessionRevokeSchema,response:{200:revoked}}},async request=>revoked.parse(await options.service.revokeNativeSession(accesses.get(request)!,request.params.id,request.body)));
 });
 if(options.installation&&options.resolveInstallationGrant){const installation=options.installation,resolve=options.resolveInstallationGrant;
  await app.register(async scope=>{const accesses=new WeakMap<FastifyRequest,FlowAccess>(),tokens=new WeakMap<FastifyRequest,{token:string;digest:string}>();scope.addHook('onRequest',async(request,reply)=>{
   const match=typeof request.headers.authorization==='string'?/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization):null;if(!match)return problem(reply,request,401,'UNAUTHORIZED');
   const digest=createHash('sha256').update(match[1]!).digest('hex');tokens.set(request,{token:match[1]!,digest});if(request.method==='DELETE')return;
   const org=await resolve(digest);if(!org)return problem(reply,request,401,'UNAUTHORIZED');
   accesses.set(request,{organizationId:z.uuid().parse(org),token:match[1]!});await limit.identity(request,org,digest,'installation');});
   const api=scope.withTypeProvider<ZodTypeProvider>();
   api.post('/v1/flow-delegations/native-installations/:id/renew',{bodyLimit:16384,schema:{params,querystring:empty,body:InstallationRenewSchema}},async(request,reply)=>reply.code(201).send(await installation.renew(accesses.get(request)!,request.params.id,request.body)));
   api.delete('/v1/flow-delegations/native-installations/:id',{bodyLimit:16384,preHandler:async(request,reply)=>{
    const token=tokens.get(request)!;const id=params.parse(request.params).id,input=InstallationRevokeSchema.parse(request.body);
    const org=await resolve(token.digest)??await options.resolveInstallationReduction?.(installationReductionDigest(id,token.token,input));
    if(!org)return problem(reply,request,401,'UNAUTHORIZED');accesses.set(request,{organizationId:z.uuid().parse(org),token:token.token});await limit.identity(request,org,token.digest,'installation-reduction');
   },schema:{params,querystring:empty,body:InstallationRevokeSchema}},request=>installation.revokeNative(accesses.get(request)!,request.params.id,request.body));
  });
 }
}
