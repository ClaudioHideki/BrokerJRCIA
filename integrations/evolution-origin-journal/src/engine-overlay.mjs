import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import { PINNED_SERVICE_LF_SHA256 } from './overlay.mjs';
import { PINNED_WEBHOOK_LF_SHA256, preparePinnedWebhookOwnership } from './webhook-overlay.mjs';
export const ENGINE_SOURCE_HASHES = Object.freeze({
  'src/main.ts': '070d5954999a0894f2a4a11928dfcac0b4818b485cfb08f9c5402468a4f9f306',
  'src/api/repository/repository.service.ts': 'a1daf5dd69bc990353e7f0d613e35774c8aa2b266aa1787333ad415af76e9bbf',
  'src/cache/rediscache.client.ts': '22bb94d835ccf91d3bb4567d55c9e120eeec1d82e860fa004f598e794d389843',
  'src/api/controllers/instance.controller.ts': 'b0921eac4e202344e9c3100754965f1b97db94faf74b7b2089ac7cca16d5713f',
  'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts': PINNED_SERVICE_LF_SHA256,
  'src/api/integrations/channel/channel.controller.ts': '2cfb9244569ead825f004846a257da3a01669e5e44363a7060f001eb81dbaf16',
  'src/api/services/channel.service.ts': 'ab8b495c07906cf66f083186a0fd6f5c4da7847b2e2492e72b28744b1e3491be',
  'src/api/integrations/event/webhook/webhook.controller.ts': PINNED_WEBHOOK_LF_SHA256,
  'src/api/integrations/event/event.manager.ts': 'ac7b8db0ab0c9f911d86f184b6d8ae5a54c75a03fe3c38c1f25a7ae9a8905c14',
  'src/api/integrations/event/event.controller.ts': '6506fdab7ffee0f6e753b51da8a300679a6491425880bd2050f35c70f4f9b0e4',
  'src/api/types/wa.types.ts': '8e4de1dc9b4252cbe3f9858c8c182fbe8c1df467744e34d60ea0827b14719bed',
});
const hash = source => createHash('sha256').update(source).digest('hex');
const ast = source => parse(source, { sourceType: 'module', plugins: ['typescript','decorators-legacy'] });
function nodes(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (predicate(node)) result.push(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) for (const item of value) nodes(item,predicate,result); else nodes(value,predicate,result);
  return result;
}

/** Returns staged full sources only. Every original source is pinned; vendor is never mutated. */
export function preparePinnedEngineSources(input) {
  const sources = {};
  for (const [path,expected] of Object.entries(ENGINE_SOURCE_HASHES)) {
    if (typeof input[path] !== 'string') throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
    const source = input[path].replaceAll('\r\n','\n');
    if (hash(source) !== expected) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
    sources[path] = source;
  }
  const servicePath = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
  let service = sources[servicePath];
  const rawConsole = '          console.log(messageRaw);';
  if (service.split(rawConsole).length !== 2) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  service = service.replace(rawConsole, '          // Do not write message payloads to unconditional process output.');
  const historyConsole = "          console.log('received on-demand history sync, messages=', messages);";
  if(service.split(historyConsole).length!==2)throw Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  service=service.replace(historyConsole,'          // On-demand history payloads must remain private.');
  const queue = nodes(ast(service), n => n.type === 'ExpressionStatement' && service.slice(n.start,n.end).startsWith('this.eventProcessingQueue = this.eventProcessingQueue.then'));
  if (queue.length !== 1) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  const statement = queue[0];
  service = service.slice(0,statement.start) + `await captureOriginBatch(this, events, () => {\n${service.slice(statement.start,statement.end)}\n});` + service.slice(statement.end);
  const client = '  private async createClient(number?: string): Promise<WASocket> {';
  if (service.split(client).length !== 2) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  service = service.replace(client, `${client}\n    await awaitOriginEngineReady(this);`);
  sources[servicePath] = `import { awaitOriginEngineReady, captureOriginBatch } from '@jrc-origin/engine-host.mjs';\n${service}`;
  const factoryPath = 'src/api/integrations/channel/channel.controller.ts';
  let factory = sources[factoryPath];
  const returns = nodes(ast(factory), n => n.type === 'ReturnStatement' && n.argument?.type === 'NewExpression' && n.argument.callee?.name === 'BaileysStartupService');
  if (returns.length !== 1) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  const target = returns[0].argument;
  factory = factory.slice(0,target.start) + `attachOriginEngineInstance(instanceData, ${factory.slice(target.start,target.end)})` + factory.slice(target.end);
  sources[factoryPath] = `import { attachOriginEngineInstance } from '@jrc-origin/engine-host.mjs';\n${factory}`;
  const basePath = 'src/api/services/channel.service.ts';
  let base = sources[basePath];
  const fanouts = nodes(ast(base), n => n.type === 'AwaitExpression' && n.argument?.type === 'CallExpression'
    && n.argument.callee?.object?.name === 'eventManager' && n.argument.callee?.property?.name === 'emit');
  if (fanouts.length !== 1) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  const fanout = fanouts[0];
  base = base.slice(0,fanout.start) + `await trackOriginEngineFanout(this, () => ${base.slice(fanout.argument.start,fanout.argument.end)})` + base.slice(fanout.end);
  sources[basePath] = `import { trackOriginEngineFanout } from '@jrc-origin/engine-host.mjs';\n${base}`;
  const webhookPath = 'src/api/integrations/event/webhook/webhook.controller.ts';
  let webhook = preparePinnedWebhookOwnership(sources[webhookPath]);
  const old = "const guard = (this as unknown as { jrcOriginWebhookGuard?: {\n          decide(input: unknown): Promise<string>;\n        } }).jrcOriginWebhookGuard;";
  if (webhook.split(old).length !== 2) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  webhook = webhook.replace(old, 'const guard = { decide: decideOriginWebhook };');
  const globalFlagShortcut = "      if (process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED !== 'true') return true;\n";
  if (webhook.split(globalFlagShortcut).length !== 2) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
  // Attached host owns the immutable opt-in. A mutable global flag must never bypass its guard.
  webhook = webhook.replace(globalFlagShortcut, '');
  sources[webhookPath] = `import { decideOriginWebhook } from '@jrc-origin/engine-host.mjs';\n${webhook}`;
  const replaceOnce = (source, before, after) => {
    if (source.split(before).length !== 2) throw new Error('ORIGIN_ENGINE_SOURCE_MISMATCH');
    return source.replace(before, after);
  };
  const instancePath = 'src/api/controllers/instance.controller.ts';
  let instanceController = sources[instancePath];
  const assignIdentity = '      const instanceId = v4();\n\n      instanceData.instanceId = instanceId;\n\n';
  instanceController = replaceOnce(instanceController, assignIdentity, '');
  instanceController = replaceOnce(instanceController, '      const instance = channelController.init(instanceData, {',
    `${assignIdentity}      const instance = channelController.init(instanceData, {`);
  sources[instancePath] = instanceController;
  const mainPath = 'src/main.ts';
  let main = sources[mainPath];
  main = replaceOnce(main, 'async function bootstrap() {', 'async function bootstrap() {\n  installRuntimeLifecycle();');
  main = replaceOnce(main, '  eventManager.init(server);', '  registerRuntimeHttp(server);\n  eventManager.init(server);');
  main = replaceOnce(main, '  initWA().catch((error) => {', '  const startup = initWA().catch((error) => {');
  main = replaceOnce(main, '  onUnexpectedError();', `  registerRuntimeDrain(async () => {
    await startup;
    // Session/socket teardown is a separate gate. Never logout/delete a session
    // or report a graceful drain merely because HTTP/DB have been closed.
    if (Object.keys(waMonitor.waInstances).length) throw Error('ORIGIN_ENGINE_SESSION_DRAIN_UNPROVEN');
  });
  onUnexpectedError();`);
  main = replaceOnce(main, "  server.listen(httpServer.PORT, () => logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT));",
    "  server.listen(httpServer.PORT, () => { markRuntimeReady(); logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT); });");
  sources[mainPath] = `import { installRuntimeLifecycle, registerRuntimeHttp, registerRuntimeDrain, markRuntimeReady } from '@jrc-origin/runtime-lifecycle.mjs';\n${main}`;
  const repositoryPath = 'src/api/repository/repository.service.ts';
  sources[repositoryPath] = `import { registerRuntimeResource } from '@jrc-origin/runtime-lifecycle.mjs';\n${replaceOnce(sources[repositoryPath], '    super();', '    super();\n    registerRuntimeResource(this, () => this.onModuleDestroy());')}`;
  const redisPath = 'src/cache/rediscache.client.ts';
  sources[redisPath] = `import { registerRuntimeResource } from '@jrc-origin/runtime-lifecycle.mjs';\n${replaceOnce(sources[redisPath], "      this.client.on('connect', () => {", `      const client = this.client;
      registerRuntimeResource(client, async () => { if (client.isOpen) await client.quit(); });
      this.client.on('connect', () => {`)}`;
  return Object.freeze({ sources: Object.freeze(sources), manifest: Object.freeze(Object.entries(sources).map(([path,source]) => Object.freeze({ path, originalLfSha256: ENGINE_SOURCE_HASHES[path], stagedLfSha256: hash(source) }))), deliveryOwnership: 'UNPROVEN' });
}
