import { expect, it } from 'vitest';
import { createOpenApiDocument } from '../../src/http/openapi.js';
it('documents the authenticated guided journey and portable package endpoints', async () => {
  const document = await createOpenApiDocument() as { paths: Record<string, any> };
  for (const path of ['/v1/guided-setups', '/v1/guided-setups/{id}/test', '/v1/guided-setups/{id}/deactivate',
    '/v1/guided-setups/{id}/package-bindings', '/v1/automation-packages', '/v1/automation-packages/{id}/publish', '/v1/automations/{id}/package']) {
    expect(document.paths).toHaveProperty(path);
    expect(Object.values(document.paths[path]!).every((value: any) => Boolean(value.security))).toBe(true);
  }
});
