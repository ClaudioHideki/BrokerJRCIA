import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GroupCompanyRemovalListSchema, GroupCompanyRemovalPreviewSchema, GroupCompanyRemovalSchema, RequestGroupCompanyRemovalSchema } from '@jrc/contracts';
import { LifecycleError } from '../../modules/lifecycle/service.js';
import type { GroupRemovalService } from '../../modules/lifecycle/group-removal-service.js';

export async function registerGroupRemovalRoutes(app:FastifyInstance,options:{service:GroupRemovalService;authorize:(req:FastifyRequest,write:boolean)=>Promise<string>}) {
  const group=z.strictObject({id:z.uuid()}),operation=z.strictObject({operationId:z.uuid()}),empty=z.strictObject({});
  const previewBody=z.strictObject({reason:z.string().trim().min(5).max(500)});
  app.post('/groups/:id/company-removal-preview',{schema:{params:group,querystring:empty,body:previewBody,response:{200:GroupCompanyRemovalPreviewSchema}}},
    async req=>options.service.preview(await options.authorize(req,true),{groupId:group.parse(req.params).id,...previewBody.parse(req.body)}));
  app.post('/groups/:id/company-removals',{schema:{params:group,querystring:empty,body:RequestGroupCompanyRemovalSchema,response:{202:GroupCompanyRemovalSchema}}},
    async(req,reply)=>{
      const actor=await options.authorize(req,true),input=RequestGroupCompanyRemovalSchema.parse(req.body);
      if(input.groupId!==group.parse(req.params).id)throw new LifecycleError('GROUP_REMOVAL_INVALID_REQUEST',400);
      return reply.code(202).send(await options.service.request(actor,input));
    });
  app.get('/group-company-removals/:operationId',{schema:{params:operation,querystring:empty,response:{200:GroupCompanyRemovalSchema}}},
    async req=>options.service.get(await options.authorize(req,false),operation.parse(req.params).operationId));
  app.get('/groups/:id/company-removals',{schema:{params:group,querystring:z.strictObject({cursor:z.uuid().optional()}),response:{200:GroupCompanyRemovalListSchema}}},
    async req=>options.service.list(await options.authorize(req,false),group.parse(req.params).id,(req.query as {cursor?:string}).cursor));
}
