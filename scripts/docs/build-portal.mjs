import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicDocument, buildReadOnlyPostman, buildControlPostman, publicProfiles } from './public-api.mjs';
import { buildPocPostman } from './postman-poc.mjs';
import { identityEnrollmentGuide } from './operation-guide.mjs';
import { documentationProvenance, verifyPdfProvenance } from './provenance.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export async function createDocumentationAssets() {
  const canonical = await readFile(resolve(directory, '../../docs/api/openapi.json'));
  const document = JSON.parse(canonical);
  const contracts = Object.fromEntries(publicProfiles.map(profile => [profile, buildPublicDocument(document, profile)]));
  const staticDirectory = resolve(dirname(require.resolve('@fastify/swagger-ui')), 'static');
  const bundle = await readFile(resolve(staticDirectory, 'swagger-ui-bundle.js'));
  // Notices below correspond to the exact Swagger UI 5.32.6 bytes shipped by the pinned dependency.
  if (createHash('sha256').update(bundle).digest('hex') !== '4b5a9b35a1adf37f00d39c0bae23cdb37007e2946240ef035137cc85b4d55349') {
    throw new Error('SWAGGER_UI_ASSET_CHANGED_REVIEW_LICENSES');
  }
  const assets = [];
  const add = (name, source) => assets.push({ fileName: 'documentation/' + name, source });
  let html = await readFile(resolve(directory, 'assets/index.html'), 'utf8');
  const extra = publicProfiles.filter(profile => !['instances', 'chatwoot'].includes(profile))
    .map(profile => `<option value="${profile}">${profile === 'messaging' ? 'Mensageria por chave' : 'Eventos e webhooks'}</option>`).join('');
  html = html.replace('<!--PUBLIC_PROFILES-->', extra);
  html = html.replace('<!--IDENTITY_ENROLLMENT-->', identityEnrollmentGuide.map(text => '<p>' + text + '</p>').join(''));
  add('index.html', html);
  const pdf = await readFile(resolve(directory, 'assets/guia-api-jrc.pdf'));
  const manifest = JSON.parse(await readFile(resolve(directory, 'assets/guia-api-jrc.json'), 'utf8'));
  const count = Object.values(contracts).reduce((n, contract) => n + Object.values(contract.paths).reduce((sum, methods) => sum + Object.keys(methods).length, 0), 0);
  verifyPdfProvenance(manifest, await documentationProvenance(), pdf, count);
  add('guia-api-jrc.pdf', pdf);
  add('postman-poc.json', JSON.stringify(buildPocPostman(), null, 2) + '\n');
  const control = buildControlPostman(contracts.chatwoot);
  add('postman-control.json', JSON.stringify(control, null, 2) + '\n');
  const variables = new Map([...buildPocPostman().variable, ...control.variable, { key: 'id', value: '' }].map(value => [value.key, value]));
  // Runtime POC IDs/run_id belong to collectionVariables; an environment would shadow them.
  for (const key of ['run_id', 'instance_id', 'channel_id', 'conversation_id', 'endpoint_id']) variables.delete(key);
  add('postman-environment.json', JSON.stringify({ name: 'JRC Broker - preencher somente em ambiente privado', _postman_variable_scope: 'environment',
    values: [...variables.values()].map(value => ({ ...value, enabled: true, type: value.type ?? 'default' })) }, null, 2) + '\n');
  add('portal.js', await readFile(resolve(directory, 'assets/portal.js')));
  add('portal.css', await readFile(resolve(directory, 'assets/portal.css')));
  add('swagger-ui-bundle.js', bundle);
  add('swagger-ui.css', await readFile(resolve(staticDirectory, 'swagger-ui.css')));
  add('LICENSE.txt', await readFile(resolve(directory, 'vendor/swagger-ui-LICENSE.txt')));
  add('NOTICE.txt', await readFile(resolve(directory, 'vendor/swagger-ui-NOTICE.txt')));
  add('swagger-ui-bundle.js.LICENSE.txt', await readFile(resolve(directory, 'vendor/swagger-ui-bundle.js.LICENSE.txt')));
  for (const profile of publicProfiles) {
    const contract = contracts[profile];
    add('openapi-' + profile + '.json', JSON.stringify(contract, null, 2) + '\n');
    add('postman-' + profile + '.json', JSON.stringify(buildReadOnlyPostman(contract), null, 2) + '\n');
  }
  return assets;
}
