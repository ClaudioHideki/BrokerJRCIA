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
