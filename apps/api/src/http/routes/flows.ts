import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { FlowGraphSchema, executeFlow, importFlow, validateFlow, welcomeFlow, triageFlow } from '@jrc/contracts';
import { FlowError, type createFlowService } from '../../modules/flows/service.js';
import { authenticateRequest, type AuthenticationOptions } from '../plugins/authentication.js';
import type { Role } from '../plugins/authorization.js';
import type { createFlowChatwootService } from '../../modules/flows/chatwoot-service.js';
import { ChatwootError } from '../../modules/integrations/chatwoot-client.js';
import { IntegrationError } from '../../modules/integrations/integration-error.js';
import { MessagingRepositoryError } from '../../modules/messaging/repository.js';
export interface FlowRouteOptions extends AuthenticationOptions {
  service:ReturnType<typeof createFlowService>;
  chatwoot?:ReturnType<typeof createFlowChatwootService>;
  resolveCurrentRole(userId:string,organizationId:string):Promise<Role|null>;
}
const params=z.strictObject({id:z.uuid()}),empty=z.strictObject({});
const draft=z.strictObject({name:z.string().trim().min(1).max(120),graph:FlowGraphSchema});
const state=z.strictObject({status:z.enum(['waiting','completed','handoff']),nodeId:z.string().max(100).nullable(),variables:z.record(z.string().max(100),z.string().max(4096)),steps:z.number().int().min(0).max(1000)});
const tenant=(req:FastifyRequest)=>req.authentication!.organizationId;
export async function registerFlowRoutes(app:FastifyInstance,options:FlowRouteOptions){
  app.decorateRequest('authentication',null);
  app.addHook('onRequest',async(_r,reply)=>{reply.header('Cache-Control','no-store');});
  app.setErrorHandler((error,request,reply)=>{
    const known=error instanceof FlowError||error instanceof IntegrationError||error instanceof ChatwootError||error instanceof MessagingRepositoryError,candidate=error as {validation?:unknown;statusCode?:number};
    const status=error instanceof MessagingRepositoryError?error.status:error instanceof ChatwootError?502:known?candidate.statusCode!:candidate.validation||error instanceof z.ZodError?400:candidate.statusCode===413?413:500;
    reply.code(status).type('application/problem+json').send({type:'about:blank',title:'Flows request failed',status,code:known?error.code:status===400?'INVALID_REQUEST':'FLOWS_UNAVAILABLE',details:error instanceof FlowError?error.details:[],requestId:request.id});
  });
  const guard=(write:boolean)=>async(req:FastifyRequest,reply:FastifyReply)=>{
    const auth=req.authentication;
    const role=auth?.kind==='JWT'?await options.resolveCurrentRole(auth.actorId,auth.organizationId):null;
    if(!role||write&&!['OWNER','ADMIN'].includes(role))return reply.code(403).send({code:'FORBIDDEN',status:403});
  };
  const read=[authenticateRequest(options),guard(false)],write=[authenticateRequest(options),guard(true)];
  const api=app.withTypeProvider<ZodTypeProvider>(),service=options.service;
  const remote=()=>{if(!options.chatwoot)throw new FlowError('CHATWOOT_NOT_CONFIGURED',409);return options.chatwoot;};
  api.get('/v1/flows/chatwoot/inboxes',{preHandler:read,schema:{querystring:empty}},req=>remote().inboxes(tenant(req)));
  api.post('/v1/flows/:id/chatwoot/bind',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({inboxId:z.number().int().positive()})}},req=>remote().bind(tenant(req),req.params.id,req.body.inboxId));
  api.post('/v1/flows/chatwoot/:id/disable',{preHandler:write,schema:{params,querystring:empty,body:empty}},req=>remote().disable(tenant(req),req.params.id));
  api.get('/v1/flows/:id/chatwoot/runs',{preHandler:read,schema:{params,querystring:empty}},req=>remote().runs(tenant(req),req.params.id));
  await app.register(async webhook=>{
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:1048576},(_req,body,done)=>done(null,body));
    webhook.post('/v1/flows/chatwoot/:id/events',{bodyLimit:1048576},async(req,reply)=>{
      const {id}=params.parse(req.params);
      if(!Buffer.isBuffer(req.body))throw new FlowError('INVALID_REQUEST',400);
      const timestamp=req.headers['x-chatwoot-timestamp'],signature=req.headers['x-chatwoot-signature'];
      const result=await remote().ingest(id,req.body,typeof timestamp==='string'?timestamp:undefined,typeof signature==='string'?signature:undefined);
      return reply.code(202).send(result);
    });
  });
  const enabled=async(org:string)=>{if(!(await service.status(org)).enabled)throw new FlowError('FLOWS_DISABLED',403);};
  api.get('/v1/flows/status',{preHandler:read,schema:{querystring:empty}},req=>service.status(tenant(req)));
  api.get('/v1/flows',{preHandler:read,schema:{querystring:empty}},req=>service.list(tenant(req)));
  api.get('/v1/flows/channels',{preHandler:read,schema:{querystring:empty}},req=>service.channels(tenant(req)));
  api.get('/v1/flows/library',{preHandler:read,schema:{querystring:empty}},async req=>{
    await enabled(tenant(req));return {data:[{id:'welcome',name:'Boas-vindas',description:'Receba o cliente com uma mensagem personalizada.',graph:welcomeFlow()},{id:'triage',name:'Triagem para atendimento',description:'Colete nome e motivo e transfira para atendimento humano.',graph:triageFlow()}]};
  });
  api.post('/v1/flows/import-preview',{bodyLimit:2100000,preHandler:write,schema:{querystring:empty,body:z.strictObject({content:z.string().max(2000000)})}},async req=>{
    await enabled(tenant(req));try{return importFlow(req.body.content);}catch(e){throw new FlowError('FLOW_IMPORT_INVALID',422,[e instanceof Error?e.message:'Arquivo inválido.']);}
  });
  api.post('/v1/flows',{preHandler:write,schema:{querystring:empty,body:draft}},async(req,reply)=>{
    const result=await service.create(tenant(req),req.body);return reply.code(201).send(result);
  });
  api.get('/v1/flows/:id',{preHandler:read,schema:{params,querystring:empty}},req=>service.get(tenant(req),req.params.id));
  api.put('/v1/flows/:id',{preHandler:write,schema:{params,querystring:empty,body:draft.extend({revision:z.number().int().positive()})}},req=>service.save(tenant(req),req.params.id,req.body));
  api.get('/v1/flows/:id/export',{preHandler:read,schema:{params,querystring:empty}},async req=>{
    const flow=await service.get(tenant(req),req.params.id);return {format:'jrc-broker-flows/1',flow:{name:flow.name,graph:flow.graph}};
  });
  api.post('/v1/flows/:id/validate',{preHandler:read,schema:{params,querystring:empty,body:empty}},async req=>{
    const flow=await service.get(tenant(req),req.params.id);return {errors:validateFlow(flow.graph)};
  });
  api.post('/v1/flows/:id/publish',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({revision:z.number().int().positive()})}},req=>service.publish(tenant(req),req.params.id,req.body.revision));
  api.post('/v1/flows/:id/bind',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({channelId:z.uuid(),replaceAutomation:z.boolean().default(false)})}},req=>service.bind(tenant(req),req.params.id,req.body.channelId,req.body.replaceAutomation));
  api.post('/v1/flows/:id/unbind',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({channelId:z.uuid()})}},req=>service.unbind(tenant(req),req.params.id,req.body.channelId));
  api.get('/v1/flows/:id/runs',{preHandler:read,schema:{params,querystring:empty}},req=>service.runs(tenant(req),req.params.id));
  api.post('/v1/flows/:id/simulate',{preHandler:write,schema:{params,querystring:empty,body:z.strictObject({text:z.string().max(4096),state:state.optional()})}},async req=>{
    const flow=await service.get(tenant(req),req.params.id),errors=validateFlow(flow.graph);
    if(errors.length)throw new FlowError('FLOW_INVALID',422,errors);
    return executeFlow(flow.graph,{text:req.body.text,variables:{'contact.name':'Cliente de teste'},...(req.body.state?{state:req.body.state}:{})});
  });
}
