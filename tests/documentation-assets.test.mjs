import { expect, it } from 'vitest';
import { createDocumentationAssets } from '../scripts/docs/build-portal.mjs';

it('packages local Swagger UI, notices and filtered contracts without a CDN or embedded key', async () => {
  const assets = Object.fromEntries((await createDocumentationAssets()).map(asset => [asset.fileName, asset.source]));
  const html = String(assets['documentation/index.html']);
  expect(html).toContain('/documentation/swagger-ui-bundle.js');
  expect(html).toContain('/documentation/guia-api-jrc.pdf');
  expect(Buffer.from(assets['documentation/guia-api-jrc.pdf']).subarray(0,5).toString()).toBe('%PDF-');
  expect(html).not.toMatch(/(?:src|href)="https?:/);
  expect(assets['documentation/swagger-ui-bundle.js']).toBeDefined();
  expect(String(assets['documentation/LICENSE.txt'])).toContain('Apache License');
  expect(String(assets['documentation/swagger-ui-bundle.js.LICENSE.txt'])).toContain('Copyright');
  const instances = JSON.parse(String(assets['documentation/openapi-instances.json']));
  expect(instances.paths['/v1/instances']).toBeDefined();
  expect(Object.keys(instances.paths).some(route => route.startsWith('/v1/platform'))).toBe(false);
  const postman = JSON.parse(String(assets['documentation/postman-instances.json']));
  expect(postman.variable.find(value => value.key === 'jrc_api_key').value).toBe('');
  expect(postman.item.every(item => item.request.method === 'GET')).toBe(true);
  const poc = JSON.parse(String(assets['documentation/postman-poc.json']));
  expect(poc.variable.find(value => value.key === 'jrc_api_key').value).toBe('');
  expect(poc.variable.find(value => value.key === 'allow_writes').value).toBe('false');
  expect(poc.item).toHaveLength(19);
  expect(poc.item.filter(value=>value.request.method!=='GET').every(value=>value.event[0].script.exec.join('\n').includes('allow_writes'))).toBe(true);
});
