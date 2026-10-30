import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { expect, it } from 'vitest';
import { buildPocPostman } from '../scripts/docs/postman-poc.mjs';
import * as publicApi from '../scripts/docs/public-api.mjs';

const source = JSON.parse(await readFile(new URL('../docs/api/openapi.json', import.meta.url), 'utf8'));
function execute(item, event, values = {}, body = {}, code = 200, shadows = {}) {
  const variables = new Map(Object.entries(values)), calls = { skipped: false, next: 'unchanged', failures: [] };
  const store = { get: name => variables.get(name), set: (name, value) => variables.set(name, value), unset: name => variables.delete(name) };
  const resolved = name => Object.hasOwn(shadows, name) ? shadows[name] : variables.get(name);
  const pm = { variables: { ...store, get: resolved, replaceIn: value => value.replace(/\{\{([^}]+)\}\}/g, (_match, name) => name === '$guid' ? 'synthetic-guid' : String(resolved(name) ?? '')) }, collectionVariables: store,
    execution: { skipRequest: () => { calls.skipped = true; }, setNextRequest: value => { calls.next = value; } },
    response: { code, json: () => body, headers: { get: () => 'application/json' } }, expect,
    test: (_name, callback) => { try { callback(); } catch (error) { calls.failures.push(error.message); } } };
  try { vm.runInNewContext(item.event.find(value => value.listen === event).script.exec.join('\n'), { pm }); }
  catch (error) { calls.error = error.message; }
  return { ...calls, variables };
}
const poc = buildPocPostman(), named = prefix => poc.item.find(item => item.name.startsWith(prefix));
const round = { broker_origin: 'https://broker.example', jrc_api_key: 'synthetic', allow_writes: 'true', run_id: 'poc-current',
  instance_id: 'created-instance', created_instance_id: 'created-instance', created_instance_run_id: 'poc-current', connected_instance_id: 'created-instance',
  channel_id: 'created-channel', created_channel_id: 'created-channel', created_channel_instance_id: 'created-instance', created_channel_run_id: 'poc-current',
  endpoint_id: 'created-endpoint', created_endpoint_id: 'created-endpoint', created_endpoint_run_id: 'poc-current' };
it.each([['05 ', 'instance_id'], ['07 ', 'instance_id'], ['09 ', 'channel_id'], ['17 ', 'endpoint_id'], ['18 ', 'instance_id']])(
  'blocks a higher-precedence environment/data resource override at %s', (prefix, variable) => {
    const result = execute(named(prefix), 'prerequest', round, {}, 200, { [variable]: 'outside-this-poc' });
    expect(result.skipped).toBe(true);
    expect(result.next).toBeNull();
  });
it.each(['05 ', '07 ', '09 ', '17 ', '18 '])('rejects resources left by a different POC round at %s', prefix => {
  const result = execute(named(prefix), 'prerequest', { ...round, run_id: 'new-round' });
  expect(result.skipped).toBe(true);
  expect(result.next).toBeNull();
});
it('permits the explicitly enabled generic actions only for resources created by the same POC round', () => {
  for (const prefix of ['05 ', '07 ', '09 ', '17 ', '18 ']) {
    expect(execute(named(prefix), 'prerequest', { ...round }).skipped, prefix).toBe(false);
  }
});
it.each([
  ['02 ', { instance: { id: 'instance' }, pending: true, reconciliationRequired: false }, 202],
  ['05 ', { action: { type: 'NONE' }, pending: false, reconciliationRequired: true }, 200],
  ['06 ', { id: 'instance', status: 'AWAITING_ACTION' }, 200],
])('actually stops the POC Runner after unsafe progress at %s', (prefix, body, code) => {
  expect(execute(named(prefix), 'test', { instance_id: 'instance' }, body, code).next).toBeNull();
});
it('does not retain an earlier CONNECTED observation after a failed status read', () => {
  const result = execute(named('06 '), 'test', { instance_id: 'instance', connected_instance_id: 'instance' }, { status: 'DISCONNECTED' });
  expect(result.variables.get('connected_instance_id')).not.toBe('instance');
});
it('does not activate or send through a different or unverified instance', () => {
  for (const prefix of ['07 ', '09 ']) {
    const result = execute(named(prefix), 'prerequest', { broker_origin: 'https://broker.example', jrc_api_key: 'synthetic', allow_writes: 'true', instance_id: 'new', connected_instance_id: 'old' });
    expect(result.skipped, prefix).toBe(true);
    expect(result.next, prefix).toBeNull();
  }
});
it('exports exactly the existing 15 control operations with no enabled mutation', () => {
  expect(publicApi.buildControlPostman).toBeTypeOf('function');
  const contract = publicApi.buildPublicDocument(source, 'chatwoot'), collection = publicApi.buildControlPostman(contract);
  const items = collection.item.flatMap(folder => folder.item);
  expect(items).toHaveLength(15);
  expect(collection.variable.find(value => value.key === 'jrc_api_key').value).toBe('');
  for (const item of items) {
    const route = item.request.url.replace('{{broker_origin}}', '').replace(/\{\{([^}]+)\}\}/g, '{$1}');
    expect(contract.paths[route]?.[item.request.method.toLowerCase()], item.name).toBeDefined();
    if (item.request.method !== 'GET') {
      const result = execute(item, 'prerequest', Object.fromEntries(collection.variable.map(v => [v.key, v.value])));
      expect(result.skipped, item.name).toBe(true);
      expect(result.error, item.name).toContain('Ação desabilitada: allow_');
    }
  }
});
it('stops a selected control mutation when its context is incomplete and after its response', () => {
  const collection = publicApi.buildControlPostman(publicApi.buildPublicDocument(source, 'chatwoot'));
  const pair = collection.item.flatMap(folder => folder.item).find(item => item.request.url.endsWith('/pair'));
  const values = { broker_origin: 'https://broker.example', jrc_api_key: 'synthetic', allow_pair: 'true' };
  const missing = execute(pair, 'prerequest', values);
  expect(missing.skipped).toBe(true);
  expect(missing.next).toBeNull();
  expect(execute(pair, 'test', values, { pending: true }, 202).next).toBeNull();
});
it('permits only the explicitly enabled control action with complete local inputs', () => {
  const collection = publicApi.buildControlPostman(publicApi.buildPublicDocument(source, 'chatwoot'));
  const values = { broker_origin: 'https://broker.example', jrc_api_key: 'synthetic', allow_pair: 'true',
    integrationId: '11111111-1111-4111-8111-111111111111', idempotency_key: 'synthetic-pair-001' };
  for (const item of collection.item.flatMap(folder => folder.item).filter(item => item.request.method !== 'GET')) {
    expect(execute(item, 'prerequest', values).skipped, item.name).toBe(!item.request.url.endsWith('/pair'));
  }
});
it('terminates a control action after success so Run All cannot chain a later approval or logout', () => {
  const collection = publicApi.buildControlPostman(publicApi.buildPublicDocument(source, 'chatwoot'));
  for (const item of collection.item.flatMap(folder => folder.item).filter(item => item.request.method !== 'GET')) {
    expect(execute(item, 'test', {}, { ok: true }, item.request.url.endsWith('/onboarding') || item.request.url.endsWith('/recover') ? 202 : 200).next, item.name).toBeNull();
  }
});
