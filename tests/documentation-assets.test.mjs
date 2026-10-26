import { expect, it } from 'vitest';
import { createDocumentationAssets } from '../scripts/docs/build-portal.mjs';
import { readFile } from 'node:fs/promises';
import { sourceTextHash } from '../scripts/docs/source-hash.mjs';
import { documentationProvenance, verifyPdfProvenance } from '../scripts/docs/provenance.mjs';

it('binds the manual to profile selection, authored PDF prose and exporter, not only route schemas', async () => {
  const manifest = JSON.parse(await readFile(new URL('../scripts/docs/assets/guia-api-jrc.json', import.meta.url), 'utf8'));
  for (const [key, file] of Object.entries({ profilesSha256: 'public-api.mjs', exporterSha256: 'export-guide.mjs', pdfGeneratorSha256: 'generate-partner-pdf.py' })) {
    expect(manifest[key], file).toBe(sourceTextHash(await readFile(new URL('../scripts/docs/' + file, import.meta.url))));
  }
  expect(manifest.operationCount).toBe(34);
});

it('rejects changed manual inputs, operation selection or PDF bytes before packaging', async () => {
  const manifest = JSON.parse(await readFile(new URL('../scripts/docs/assets/guia-api-jrc.json', import.meta.url), 'utf8'));
  const pdf = await readFile(new URL('../scripts/docs/assets/guia-api-jrc.pdf', import.meta.url)), sources = await documentationProvenance();
  expect(() => verifyPdfProvenance(manifest, sources, pdf, 34)).not.toThrow();
  for (const key of Object.keys(sources)) expect(() => verifyPdfProvenance(manifest, { ...sources, [key]: 'changed' }, pdf, 34)).toThrow('PDF_STALE');
  expect(() => verifyPdfProvenance(manifest, sources, pdf, 33)).toThrow('PDF_STALE');
  expect(() => verifyPdfProvenance(manifest, sources, Buffer.from('changed'), 34)).toThrow('PDF_STALE');
});

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
  const control = JSON.parse(String(assets['documentation/postman-control.json']));
  expect(control.item.flatMap(folder => folder.item)).toHaveLength(15);
  const environment = JSON.parse(String(assets['documentation/postman-environment.json']));
  expect(environment.values.find(value => value.key === 'jrc_api_key').value).toBe('');
  expect(environment.values.filter(value => value.key.startsWith('allow_')).every(value => value.value === 'false')).toBe(true);
  expect(environment.values.some(value => ['run_id', 'instance_id', 'channel_id', 'endpoint_id'].includes(value.key))).toBe(false);
  expect(html).toContain('GET status e a observação de saúde nunca autorizam nem aprovam identidade.');
});
