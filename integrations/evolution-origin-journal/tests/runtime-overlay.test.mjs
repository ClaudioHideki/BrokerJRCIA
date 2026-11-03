import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import vm from 'node:vm';
import { ENGINE_SOURCE_HASHES, preparePinnedEngineSources } from '../src/engine-overlay.mjs';

const paths = ['src/main.ts', 'src/api/repository/repository.service.ts', 'src/cache/rediscache.client.ts'];
async function preparedSources() {
  const originals = {};
  for (const path of new Set([...Object.keys(ENGINE_SOURCE_HASHES), ...paths])) originals[path] = await readFile(new URL(`../../../upstream/evolution-api/${path}`, import.meta.url), 'utf8');
  return { originals, prepared: preparePinnedEngineSources(originals) };
}
async function execute(source, dependencies) {
  const code = (await transform(source, { loader: 'ts', format: 'cjs', target: 'node24', tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } } })).code;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, process, console, Buffer });
  return module.exports;
}

test('pinned repository instances and Redis connections register the actual close operation', async () => {
  const { originals, prepared } = await preparedSources();
  const resources = new Map(), closed = [];
  const lifecycle = { registerRuntimeResource: (resource, close) => resources.set(resource, close) };
  class Logger { warn() {} info() {} verbose() {} error() {} }
  class PrismaClient { async $disconnect() { closed.push(this); } }
  const path = paths[1];
  const { PrismaRepository } = await execute(prepared.sources[path] ?? originals[path], {
    '@config/env.config': {}, '@config/logger.config': { Logger }, '@prisma/client': { PrismaClient }, '@jrc-origin/runtime-lifecycle.mjs': lifecycle,
  });
  const first = new PrismaRepository({}), second = new PrismaRepository({});
  assert.equal(resources.size, 2, 'both upstream Prisma clients must be owned by shutdown');
  await Promise.all([...resources.values()].map(close => close()));
  assert.deepEqual(closed, [first, second]);
  const client = { isOpen: true, on() {}, connect() {}, async quit() { closed.push(this); this.isOpen = false; } };
  const redisPath = paths[2];
  const { redisClient } = await execute(prepared.sources[redisPath] ?? originals[redisPath], {
    '@config/env.config': { configService: { get: () => ({ REDIS: { URI: 'redis://synthetic.invalid' } }) } },
    '@config/logger.config': { Logger }, redis: { createClient: () => client }, '@jrc-origin/runtime-lifecycle.mjs': lifecycle,
  });
  assert.equal(redisClient.getConnection(), client);
  assert.equal(resources.has(client), true);
  await resources.get(client)();
  assert.equal(client.isOpen, false);
});

test('main registers HTTP and startup drain before listen without deleting active instances', async () => {
  const { originals, prepared } = await preparedSources(), order = [], drains = [];
  const app = { use() {}, set() {} }, express = Object.assign(() => app, { static() {}, json() {}, urlencoded() {} });
  const server = { listen(_port, callback) { order.push('listen'); callback(); } };
  let release;
  const load = new Promise(resolve => { release = resolve; });
  const monitor = { waInstances: {}, loadInstance: () => load };
  class Logger { info() {} log() {} error() {} warn() {} }
  const dependencies = {
    '@utils/instrumentSentry': {}, '@api/provider/sessions': {},
    '@api/repository/repository.service': { PrismaRepository: class { async onModuleInit() {} } },
    '@api/routes/index.router': { router: {} }, '@api/server.module': { eventManager: { init() {} }, waMonitor: monitor },
    '@config/env.config': { configService: { get(name) { return name === 'SERVER' ? { TYPE: 'http', PORT: 8080 } : name === 'CORS' ? { METHODS: [] } : {}; } } },
    '@config/error.config': { onUnexpectedError() {} }, '@config/logger.config': { Logger }, '@config/path.config': { ROOT_DIR: '/synthetic' },
    '@sentry/node': {}, '@utils/server-up': { ServerUP: { http: server } }, axios: {}, compression: () => {}, cors: () => {}, express,
    path: { join: (...parts) => parts.join('/') },
    '@jrc-origin/runtime-lifecycle.mjs': { installRuntimeLifecycle() { order.push('install'); }, registerRuntimeHttp(value) { assert.equal(value, server); order.push('register'); }, registerRuntimeDrain(fn) { drains.push(fn); }, markRuntimeReady() { order.push('ready'); } },
  };
  await execute(prepared.sources[paths[0]] ?? originals[paths[0]], dependencies);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['install', 'register', 'listen', 'ready']);
  assert.equal(drains.length, 1);
  let done = false;
  const draining = drains[0]().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  release(); await draining;
  monitor.waInstances.synthetic = { eventProcessingQueue: Promise.resolve() };
  await assert.rejects(drains[0](), /ORIGIN_ENGINE_SESSION_DRAIN_UNPROVEN/u);
  assert.equal(Object.keys(monitor.waInstances).length, 1, 'shutdown must not log out or delete sessions');
});
