import { expect, it } from 'vitest';
import { createOpenApiDocument } from '../../src/http/openapi.js';

it('documents JWT-only tenant routes and public platform login configuration accurately', async () => {
  const document = await createOpenApiDocument() as { paths: Record<string, Record<string, {security?: unknown}>> };
  for (const path of ['/v1/channels', '/v1/channels/{id}/whatsapp-groups', '/v1/channels/{id}/whatsapp-groups/refresh', '/v1/channels/{id}/whatsapp-groups/selection', '/v1/credentials', '/v1/automations', '/v1/automation-imports/preview', '/v1/organization/overview', '/v1/executions']) {
    for (const operation of Object.values(document.paths[path]!)) expect(operation.security, path).toEqual([{bearerAuth: []}]);
  }
  expect(document.paths['/v1/platform/auth/config']!.get!.security).toEqual([]);
  expect(document.paths['/v1/platform/organizations']!.get!.security).toEqual([{platformSession: []}]);
});
it('documents actual Evolution ingress with channel credentials and correlated optional receipt headers',async()=>{
  const document=await createOpenApiDocument() as {paths:Record<string,{post?:{security?:unknown;parameters?:Array<{name:string}>;responses?:Record<string,unknown>}}>};
  const operation=document.paths['/v1/webhooks/whatsapp/{id}']?.post;
  expect(operation).toBeDefined();
  expect(operation!.security).toEqual([{qrWebhookBearer:[]}]);
  expect(operation!.parameters?.map(p=>p.name)).toEqual(expect.arrayContaining(['x-jrc-origin-event-id','x-jrc-origin-content-sha256']));
  expect(operation!.responses).toHaveProperty('409');
});
