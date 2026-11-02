import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { bindingFingerprint, createOriginJournal } from '../src/journal.mjs';
import { projectTextBatch } from '../src/projection.mjs';
import { createOriginWebhookOwnershipGuard } from '../src/webhook-ownership.mjs';
import { preparePinnedWebhookOwnership } from '../src/webhook-overlay.mjs';
import { binding as template, source } from './fixtures.mjs';
const binding = { ...template, destinationId: randomUUID() };
const endpoint = `https://broker.invalid/v1/webhooks/whatsapp/${binding.destinationId}`;
const body = () => projectTextBatch(binding, source())[0];
const hash = value => createHash('sha256').update(value).digest('hex');
function proof(envelope = body()) {
  return { id: randomUUID(), scopeKey: hash(JSON.stringify([binding.instanceId,binding.generation,binding.destinationId,binding.revision])),
    bindingFingerprint: bindingFingerprint(binding), eventKey: hash(JSON.stringify([envelope.data.key.id,envelope.data.key.fromMe,envelope.data.key.remoteJid])), bodyHash: hash(JSON.stringify(envelope)) };
}
const input = (destination = endpoint, envelope = body()) => ({ instanceName: envelope.instance, event: envelope.event, data: envelope.data, destination });
const guard = (lookup = async () => proof(), resolveBinding = async () => binding, options = {}) => createOriginWebhookOwnershipGuard({ env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' }, journal: { lookupCommittedOwnership: lookup }, binding, endpoint, resolveBinding, ...options });

test('ownership suppresses only exact durable scope/event/hash proof, never a raw boolean', async () => {
  assert.equal(await guard().decide(input()), 'SUPPRESS_OWNED');
  assert.equal(await guard(async () => null).decide(input()), 'DELIVER_LEGACY');
  for (const value of [true, { ...proof(), id: '-'.repeat(36) }, { ...proof(), bodyHash: '0'.repeat(64) }, { ...proof(), scopeKey: '0'.repeat(64) }, { ...proof(), bindingFingerprint: '0'.repeat(64) }]) {
    await assert.rejects(guard(async () => value).decide(input()), /ORIGIN_WEBHOOK_OWNERSHIP_INVALID/);
  }
});
test('ownership preserves unrelated destination and unsupported event/media without journal query', async () => {
  const current = guard(async () => { throw new Error('must not query'); });
  assert.equal(await current.decide(input('https://other.invalid/events')), 'DELIVER_LEGACY');
  assert.equal(await current.decide({ ...input(), event: 'messages.set' }), 'DELIVER_LEGACY');
  assert.equal(await current.decide({ ...input(), data: { ...body().data, message: { imageMessage: { caption: 'Synthetic' } } } }), 'DELIVER_LEGACY');
  await assert.rejects(current.decide(input(`${endpoint}/messages-upsert`)), /ORIGIN_WEBHOOK_DESTINATION_CHANGED/);
});
test('ownership fences before and after lookup and bounds unavailable authority', async () => {
  await assert.rejects(guard(undefined, async () => ({ ...binding, revision: 2 })).decide(input()), /ORIGIN_WEBHOOK_BINDING_CHANGED/);
  let calls = 0;
  await assert.rejects(guard(undefined, async () => ++calls === 1 ? binding : ({ ...binding, generation: 2 })).decide(input()), /ORIGIN_WEBHOOK_BINDING_CHANGED/);
  await assert.rejects(guard(undefined, async () => new Promise(() => {}), { timeoutMs: 20 }).decide(input()), /ORIGIN_WEBHOOK_OWNERSHIP_UNAVAILABLE/);
  await assert.rejects(guard(async () => new Promise(() => {}), undefined, { timeoutMs: 20 }).decide(input()), /ORIGIN_WEBHOOK_OWNERSHIP_UNAVAILABLE/);
  calls = 0;
  await assert.rejects(guard(undefined, async () => ++calls === 1 ? binding : new Promise(() => {}), { timeoutMs: 20 }).decide(input()), /ORIGIN_WEBHOOK_OWNERSHIP_UNAVAILABLE/);
});

test('journal committed-read port queries exact identity and never manufactures missing ownership', async () => {
  let observed;
  const pool = { async query(sql, params) { observed = { sql, params }; return { rows: [] }; } };
  const journal = createOriginJournal({ pool, encryptionKey: Buffer.alloc(32, 1) });
  assert.equal(await journal.lookupCommittedOwnership(binding, body()), null);
  assert.deepEqual(observed.params, [proof().scopeKey, proof().eventKey]);
  assert.match(observed.sql, /SELECT.*id.*scope_key.*event_key.*binding_fingerprint.*body_hash/su);
  assert.doesNotMatch(observed.sql, /INSERT|UPDATE|DELETE/u);
});

async function preparedController() {
  const original = await readFile(new URL('../../../upstream/evolution-api/src/api/integrations/event/webhook/webhook.controller.ts', import.meta.url), 'utf8');
  const prepared = preparePinnedWebhookOwnership(original);
  assert.ok(preparePinnedWebhookOwnership(original.replaceAll('\r\n','\n')));
  assert.throws(() => preparePinnedWebhookOwnership(original + '\n'), /ORIGIN_WEBHOOK_SOURCE_MISMATCH/);
  const ast = parse(prepared, { sourceType: 'module', plugins: ['typescript'] });
  const declaration = ast.program.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration').declaration;
  const method = declaration.body.body.find(node => node.key?.name === 'emit');
  return stripTypeScriptTypes(`class Controller { ${prepared.slice(method.start, method.end).replace('override ', '')} } globalThis.Controller=Controller;`);
}
test('actual pinned webhook local/global branches suppress only owned endpoint and preserve unowned branches', async () => {
  const code = await preparedController(), sends = [];
  const config = { GLOBAL: { ENABLED: true, URL: endpoint, WEBHOOK_BY_EVENTS: false }, EVENTS: { MESSAGES_UPSERT: true } };
  const context = vm.createContext({ process: { env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' } }, configService: { get: name => name === 'LOG' ? { LEVEL: [] } : config }, axios: { create: options => options } });
  vm.runInContext(code, context);
  const controller = new context.Controller();
  controller.get = async () => ({ enabled: true, events: ['MESSAGES_UPSERT'], url: endpoint });
  controller.retryWebhookRequest = async (_http, _body, _origin, destination) => sends.push(destination);
  controller.logger = { error() {}, log() {} }; controller.jrcOriginWebhookGuard = guard();
  await controller.emit({ ...input(), local: true }); assert.deepEqual(sends, []);
  config.GLOBAL.URL = 'https://other.invalid/events';
  await controller.emit({ ...input(), local: true }); assert.deepEqual(sends, ['https://other.invalid/events']);
  controller.get = async () => ({ enabled: true, events: ['MESSAGES_UPSERT'], url: 'https://local-other.invalid/events' });
  await controller.emit({ ...input(), local: true }); assert.equal(sends.length, 3);
  delete controller.jrcOriginWebhookGuard;
  await controller.emit({ ...input(), local: true }); assert.equal(sends.length, 3);
  context.process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED = 'false';
  await controller.emit({ ...input(), local: true }); assert.equal(sends.length, 5);
  context.process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED = 'true';
  controller.jrcOriginWebhookGuard = guard();
  config.GLOBAL.URL = endpoint; config.EVENTS.MESSAGES_SET = true;
  controller.get = async () => ({ enabled: true, events: ['MESSAGES_SET'], url: endpoint });
  await controller.emit({ ...input(), event: 'messages.set', local: true }); assert.equal(sends.length, 7);
});
test('actual pinned generic fanout still invokes every nonwebhook integration once', async () => {
  const source = await readFile(new URL('../../../upstream/evolution-api/src/api/integrations/event/event.manager.ts', import.meta.url), 'utf8');
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  const declaration = ast.program.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration').declaration;
  const method = declaration.body.body.find(node => node.key?.name === 'emit');
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(`class Manager { ${source.slice(method.start,method.end)} } globalThis.Manager=Manager;`), context);
  const manager = new context.Manager(), calls = [], sends = [];
  const controllerContext = vm.createContext({ process: { env: { JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED: 'true' } },
    configService: { get: name => name === 'LOG' ? { LEVEL: [] } : { GLOBAL: { ENABLED: true, URL: endpoint }, EVENTS: { MESSAGES_UPSERT: true } } }, axios: { create: options => options } });
  vm.runInContext(await preparedController(), controllerContext);
  const controller = new controllerContext.Controller();
  controller.get = async () => ({ enabled: true, events: ['MESSAGES_UPSERT'], url: endpoint });
  controller.jrcOriginWebhookGuard = guard(); controller.logger = { error() {}, log() {} };
  controller.retryWebhookRequest = async () => sends.push('unexpected-http');
  for (const name of ['websocket','rabbitmq','nats','sqs','pusher','kafka']) manager[name] = { emit: async () => calls.push(name) };
  manager.webhook = { emit: async value => { calls.push('webhook'); await controller.emit(value); } };
  await manager.emit({ ...input(), local: true });
  assert.deepEqual(calls, ['websocket','rabbitmq','nats','sqs','webhook','pusher','kafka']); assert.deepEqual(sends, []);
  for (const localOwned of [true,false]) {
    calls.length = 0; sends.length = 0;
    const globalDestination = localOwned ? 'https://unrelated-global.invalid/events' : endpoint;
    controllerContext.configService.get = name => name === 'LOG' ? { LEVEL: [] } : { GLOBAL: { ENABLED: true, URL: globalDestination }, EVENTS: { MESSAGES_UPSERT: true } };
    controller.get = async () => ({ enabled: true, events: ['MESSAGES_UPSERT'], url: localOwned ? endpoint : 'https://unrelated-local.invalid/events' });
    controller.jrcOriginWebhookGuard = guard(async () => { throw new Error('sensitive SQL failure must not appear'); });
    controller.retryWebhookRequest = async (_http,_body,_origin,destination) => sends.push(destination);
    const failures = []; controller.logger.error = value => failures.push(value);
    await manager.emit({ ...input(), local: true });
    assert.deepEqual(calls, ['websocket','rabbitmq','nats','sqs','webhook','pusher','kafka']);
    assert.deepEqual(sends, [localOwned ? 'https://unrelated-global.invalid/events' : 'https://unrelated-local.invalid/events']);
    assert.equal(failures.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(failures[0])), { local: 'JRC_ORIGIN_WEBHOOK', code: 'ORIGIN_WEBHOOK_GUARD_FAILED' });
  }
});
