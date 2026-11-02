import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { parse } from '@babel/parser';
import { projectTextBatch } from '../src/projection.mjs';
import { createOriginCaptureHook } from '../src/hook.mjs';
import { preparePinnedSourceHook } from '../src/overlay.mjs';

import { binding, source } from './fixtures.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';

test('lab database guard rejects protocol, query/hash overrides, nonlab targets and production before I/O', () => {
  for (const raw of ['https://localhost/lab_fixture', 'postgres://localhost/lab_fixture?host=outside.example.test', 'postgres://localhost/lab_fixture#override', 'postgres://outside.example.test/lab_fixture', 'postgres://localhost/postgres', undefined]) {
    assert.throws(() => validateTestAdminUrl(raw, 'test'), /Dedicated loopback/);
  }
  assert.throws(() => validateTestAdminUrl('postgres://localhost/lab_fixture', 'production'), /Dedicated loopback/);
  assert.equal(validateTestAdminUrl('postgresql://127.0.0.1:15439/lab_fixture', 'test').hostname, '127.0.0.1');
});

test('projects individual notify text and strips unrelated sensitive fields', () => {
  const facts = projectTextBatch(binding, source());
  assert.equal(facts.length, 1);
  assert.equal(facts[0].event, 'messages.upsert');
  assert.deepEqual(facts[0].data.message, { conversation: 'Synthetic text' });
  assert.equal(facts[0].data.key.id, 'provider-message-a');
  assert.equal(JSON.stringify(facts).includes('must-not-survive'), false);
});

test('does not admit groups, media, history, unsupported identities or append imports', () => {
  const events = source();
  events['messages.upsert'].messages.push({ key: { id: 'group', fromMe: false, remoteJid: 'synthetic@g.us' }, message: { conversation: 'Group' } });
  events['messages.upsert'].messages.push({ key: { id: 'media', fromMe: false, remoteJid: `${'1'.repeat(11)}@s.whatsapp.net` }, message: { imageMessage: { mediaKey: 'must-not-survive' } } });
  events['messages.upsert'].messages.push({ key: { id: 'lid', fromMe: false, remoteJid: 'synthetic@lid' }, message: { conversation: 'Unresolved' } });
  assert.equal(projectTextBatch(binding, events).length, 1);
  events['messages.upsert'].type = 'append';
  assert.deepEqual(projectTextBatch(binding, events), []);
  assert.deepEqual(projectTextBatch(binding, { 'messaging-history.set': source()['messages.upsert'] }), []);
});

test('rejects malformed supported text before accepting any part of its batch', () => {
  const events = source();
  events['messages.upsert'].messages.push({ ...events['messages.upsert'].messages[0], key: { ...events['messages.upsert'].messages[0].key, id: '' } });
  assert.throws(() => projectTextBatch(binding, events), /ORIGIN_TEXT_INVALID/);
});

test('projects protobuf Long timestamps without persisting the provider object', () => {
  const events = source();
  events['messages.upsert'].messages[0].messageTimestamp = { low: 1700000000, high: 0, unsigned: true };
  assert.equal(projectTextBatch(binding, events)[0].data.messageTimestamp, 1700000000);
});

test('does not reinterpret edited or protocol-bearing messages as new live text', () => {
  const events = source();
  events['messages.upsert'].messages[0].message.protocolMessage = { type: 'edit' };
  assert.deepEqual(projectTextBatch(binding, events), []);
});

test('strict opt-in performs no capture while disabled and fails closed without a journal', async () => {
  for (const value of [undefined, 'false', 'TRUE', '1']) {
    const hook = createOriginCaptureHook({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: value }, binding });
    assert.deepEqual(await hook.capture(source()), { captured: 0, enabled: false });
  }
  const hook = createOriginCaptureHook({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, binding });
  await assert.rejects(hook.capture(source()), /ORIGIN_JOURNAL_UNAVAILABLE/);
  assert.equal(hook.deliveryOwnership, 'UNPROVEN', 'capture alone cannot suppress every original webhook path');
});

test('awaits the durable capture promise and does not turn a rejected capture into success', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const hook = createOriginCaptureHook({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, binding, journal: { acceptBatch: async () => { await waiting; return [{ id: 'durable-id' }]; } } });
  let complete = false;
  const captured = hook.capture(source()).then(result => { complete = true; return result; });
  await Promise.resolve();
  assert.equal(complete, false);
  finish();
  assert.deepEqual(await captured, { captured: 1, enabled: true });
  const failing = createOriginCaptureHook({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, binding, journal: { acceptBatch: async () => { throw new Error('ORIGIN_CAPTURE_UNAVAILABLE'); } } });
  await assert.rejects(failing.capture(source()), /ORIGIN_CAPTURE_UNAVAILABLE/);
});

test('prepares the pinned real callback and awaits capture before its volatile queue assignment', async () => {
  const original = await readFile(new URL('../../../upstream/evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', import.meta.url), 'utf8').catch(async () => readFile(new URL('../../../../upstream/evolution-api/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', import.meta.url), 'utf8'));
  const prepared = preparePinnedSourceHook(original);
  assert.ok(preparePinnedSourceHook(original.replaceAll('\r\n', '\n')).includes('ORIGIN_HOOK_NOT_INSTALLED'));
  assert.throws(() => preparePinnedSourceHook(`${original}\n`), /ORIGIN_SOURCE_MISMATCH/);
  const ast = parse(prepared, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] });
  const declaration = ast.program.body.flatMap(node => node.type === 'ExportNamedDeclaration' ? [node.declaration] : [node]).find(node => node?.type === 'ClassDeclaration' && node.body.body.some(member => member.key?.name === 'eventHandler'));
  const member = declaration.body.body.find(node => node.key?.name === 'eventHandler');
  const method = prepared.slice(member.start, member.end);
  assert.ok(method);
  const compiled = stripTypeScriptTypes(`class CapturedSource { ${method} } globalThis.CapturedSource = CapturedSource;`);
  const context = vm.createContext({ process: { env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' } } });
  vm.runInContext(compiled, context);
  const instance = new context.CapturedSource();
  let callback, committed = false, enqueueCount = 0, resolveCapture;
  instance.client = { ev: { process: fn => { callback = fn; } } };
  instance.endSession = true;
  let queue = Promise.resolve();
  Object.defineProperty(instance, 'eventProcessingQueue', { get: () => queue, set: value => { assert.equal(committed, true); enqueueCount++; queue = value; } });
  instance.jrcOriginJournal = { deliveryOwnership: 'INTEGRATION_ONLY', capture: async () => { await new Promise(resolve => { resolveCapture = resolve; }); committed = true; return { enabled: true, captured: 1 }; } };
  instance.eventHandler();
  const result = callback(source());
  assert.equal(enqueueCount, 0);
  resolveCapture();
  await result;
  assert.equal(enqueueCount, 1);
  delete instance.jrcOriginJournal;
  await assert.rejects(callback(source()), /ORIGIN_HOOK_NOT_INSTALLED/);
  assert.equal(enqueueCount, 1);
  instance.jrcOriginJournal = { deliveryOwnership: 'INTEGRATION_ONLY', capture: async () => ({ enabled: false, captured: 0 }) };
  await assert.rejects(callback(source()), /ORIGIN_CAPTURE_NOT_ENABLED/);
  assert.equal(enqueueCount, 1);
});
