import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import { PINNED_SERVICE_LF_SHA256 } from './overlay.mjs';
import { PINNED_WEBHOOK_LF_SHA256, preparePinnedWebhookOwnership } from './webhook-overlay.mjs';
export const ENGINE_SOURCE_HASHES = Object.freeze({
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
  return Object.freeze({ sources: Object.freeze(sources), manifest: Object.freeze(Object.entries(sources).map(([path,source]) => Object.freeze({ path, originalLfSha256: ENGINE_SOURCE_HASHES[path], stagedLfSha256: hash(source) }))), deliveryOwnership: 'UNPROVEN' });
}
