import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { AUTOMATION_NODE_CATALOG_V1 } from '../packages/contracts/dist/index.js';

const directory = path.resolve(process.argv[2] ?? '.sessions/native-flow-editor');
assert.ok(!/[\t ]+$/m.test(await readFile(path.join(directory, 'editor.js'), 'utf8')),
  'Native editor release JavaScript must pass the host Git whitespace check without changing string values');
const org = '11111111-2222-4333-8444-555555555555', id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const handle = '12345678-1234-4234-8234-123456789abc', channel = '76543210-1234-4234-8234-123456789abc';
const graph = { nodes: [
  { id: 'start', type: 'start', label: 'Início', position: { x: 0, y: 0 }, data: {} },
  { id: 'note', type: 'note', label: 'Nota da equipe', position: { x: 300, y: 0 }, data: { conversationEffectVersion: 2,
    operation: 'note', channelId: '', text: '', target: 'action.result', timeoutMs: 15000 } },
  { id: 'end', type: 'end', label: 'Fim', position: { x: 600, y: 0 }, data: {} },
], edges: [{ id: 'a', source: 'start', target: 'note', port: 'next' }, { id: 'b', source: 'note', target: 'end', port: 'success' }] };
const item = { schemaVersion: 1, id, organizationId: org, name: 'Homologação sintética', lifecycleStatus: 'DRAFT',
  draft: { revision: 1, graph }, activeVersion: null, updatedAt: '2026-10-15T12:00:00.000Z', scopeRevision: 1 };
const data = JSON.stringify({ item, org, id, handle, channel, catalog: AUTOMATION_NODE_CATALOG_V1 });
const html = `<!doctype html><html><head><meta charset="utf-8"><style>#host-title{color:rgb(90, 50, 10)}button{font-size:41px}</style></head><body>
<h2 id="host-title">Central anfitriã</h2><div id="native"></div><script type="module">
import {mountNativeFlowEditor} from '/jrc-flow-editor/editor.js';
const fixture=${data}, prefix='/api/v1/accounts/3/jrc_flow_delegation/sessions/'+fixture.handle+'/flows';
window.nativeFlowCalls=[];
const supported={state:'SUPPORTED',reason:null};
window.closeNative=mountNativeFlowEditor(document.getElementById('native'),{accountId:3,handleId:fixture.handle,integrationIds:[fixture.channel],
 context:{organizationId:fixture.org,accountId:3,actorId:9,scopes:['flow:read','flow:edit'],expiresAt:new Date(Date.now()+60000).toISOString()},
 request:async(method,path,body)=>{window.nativeFlowCalls.push({method,path,body});const suffix=path.slice(prefix.length).split('?')[0];
  if(path.slice(0,prefix.length)!==prefix)throw Error('FOREIGN_SCOPE');
  if(suffix==='/status')return {enabled:true,canEdit:true,canPublish:true,reasons:[]};
  if(suffix==='/nodes')return {data:fixture.catalog};
  if(suffix==='')return {data:[fixture.item],nextCursor:null};
  if(suffix==='/'+fixture.id)return fixture.item;
  if(suffix.endsWith('/resource-channels'))return {schemaVersion:1,scope:{organizationId:fixture.org,rootAutomationId:fixture.id},data:[{id:fixture.channel,name:'Suporte sintético'}],nextCursor:null};
  if(suffix.endsWith('/action-catalog'))return {schemaVersion:1,scope:{organizationId:fixture.org,rootAutomationId:fixture.id,channelId:fixture.channel},profile:'STANDALONE',capabilities:Object.fromEntries(['tag','attribute','note','resolve','media'].map(k=>[k,supported])),data:[],nextCursor:null};
  throw Error('UNEXPECTED_REQUEST '+suffix);
 }});</script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const match = /^\/jrc-flow-editor\/(editor\.(?:js|css))$/.exec(pathname);
    if (!match) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', match[1].endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(await readFile(path.join(directory, match[1])));
  } catch { res.statusCode = 500; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const launch = process.env.JRC_TEST_BROWSER_CHANNEL ? { channel: process.env.JRC_TEST_BROWSER_CHANNEL } : {};
  browser = await chromium.launch({ headless: true, ...launch });
  const page = await browser.newPage(), errors = [], external = [];
  page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('link', { name: 'Abrir editor' }).click();
  await page.getByLabel('Nome da automação').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Publicar', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Configurar Nota da equipe', exact: true }).click();
  await page.getByLabel('Caixa da ação').selectOption({ label: 'Suporte sintético' });
  await page.getByLabel('Nota interna', { exact: true }).fill('Nota de teste sem mensagem pública');
  assert.equal(await page.getByRole('button', { name: 'Salvar', exact: true }).isEnabled(), true);
  assert.equal(await page.locator('#host-title').evaluate(el => getComputedStyle(el).color), 'rgb(90, 50, 10)');
  assert.equal(await page.getByRole('button', { name: 'Publicar', exact: true }).evaluate(el => getComputedStyle(el).fontSize) === '41px', false);
  const calls = await page.evaluate(() => window.nativeFlowCalls);
  assert.ok(calls.some(call => call.path.endsWith('/resource-channels')));
  assert.ok(calls.every(call => call.method === 'get' && call.path.startsWith(`/api/v1/accounts/3/jrc_flow_delegation/sessions/${handle}/flows`)));
  await page.evaluate(() => window.closeNative());
  assert.equal(await page.locator('#native').evaluate(el => el.shadowRoot.childElementCount), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ nativeBundle: 'PASS', scenarios: ['shared-editor', 'named-box', 'private-note-draft', 'publish-scope', 'shadow-css', 'session-close'], externalRequests: external.length }));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
