// Compiles whole pinned classes. Network/auth/Prisma/chatbot dependencies are explicit synthetic fixtures.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { transform } from 'esbuild';
import vm from 'node:vm';
import * as host from '../src/engine-host.mjs';
import { ENGINE_SOURCE_HASHES, preparePinnedEngineSources } from '../src/engine-overlay.mjs';
const requireNative = createRequire(import.meta.url);
export async function compileEngineFixture({ endpoint, globalEndpoint, onLegacyHttp = async () => {}, onSink = async () => {},
  preserveMessageHandler = false, onConsole = () => {} } = {}) {
  const originals = {};
  for (const path of Object.keys(ENGINE_SOURCE_HASHES)) originals[path] = await readFile(new URL(`../../../upstream/evolution-api/${path}`,import.meta.url),'utf8');
  const apiPath = 'src/api/controllers/instance.controller.ts';
  originals[apiPath] ??= await readFile(new URL(`../../../upstream/evolution-api/${apiPath}`,import.meta.url),'utf8');
  const prepared = preparePinnedEngineSources(originals), codes = {};
  for (const [path,source] of Object.entries({[apiPath]:originals[apiPath],...prepared.sources})) codes[path] = (await transform(source,{loader:'ts',format:'cjs',target:'node24',sourcefile:path,tsconfigRaw:{compilerOptions:{useDefineForClassFields:false,experimentalDecorators:true}}})).code;
  const calls = [], errors = [], server = { chatbotController: { emit: async () => {} } }, monitor = { waInstances: {} }, pendingFanouts = new Set();
  const config = { get(name) {
    if (name === 'LOG') return { BAILEYS: 'silent', LEVEL: [] };
    if (name === 'WEBHOOK') return { GLOBAL: { ENABLED: Boolean(globalEndpoint), URL: globalEndpoint }, EVENTS: { MESSAGES_UPSERT: true }, RETRY: { MAX_ATTEMPTS: 1 } };
    if (name === 'SERVER') return { URL: 'https://synthetic-engine.invalid' };
    if (name === 'DATABASE') return { SAVE_DATA: {} };
    return {};
  } };
  class Noop { mount() {} getEngine() { return {}; } info() {} log() {} verbose() {} warn() {} setInstance() {} error(value) { errors.push(value); } }
  const prisma = { webhook: { findUnique: async () => ({ enabled:true,events:['MESSAGES_UPSERT'],url:endpoint }) },
    chat: { findFirst: async () => null }, contact: { findFirst: async () => null } };
  const modules = new Map(), aliases = {
    '@api/services/channel.service':'src/api/services/channel.service.ts',
    '@api/types/wa.types':'src/api/types/wa.types.ts',
    './whatsapp/whatsapp.baileys.service':'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
    '@api/integrations/event/webhook/webhook.controller':'src/api/integrations/event/webhook/webhook.controller.ts',
    '../event.controller':'src/api/integrations/event/event.controller.ts',
  };
  function dependency(name) {
    if (aliases[name]) return load(aliases[name]);
    if (name === '@jrc-origin/engine-host.mjs') return host;
    if (name === '@api/server.module') return server;
    if (name === 'uuid') return { v4: randomUUID };
    if (name === 'class-validator') return { isArray: Array.isArray };
    if (name === '@exceptions') return { BadRequestException: class extends Error {} };
    if (name === '@config/env.config') return { configService:config };
    if (name === '@config/logger.config') return { Logger:Noop };
    if (name === '@api/services/cache.service') return { CacheService:Noop };
    if (name === '@cache/cacheengine') return { CacheEngine:Noop };
    if (name.includes('/chatbot/') && name.endsWith('.service')) return { ChatwootService:Noop,OpenaiService:Noop,TypebotService:Noop,DifyService:Noop };
    if (name === './baileysMessage.processor') return { BaileysMessageProcessor:Noop };
    if (name === '@utils/use-multi-file-auth-state-provider-files') return { AuthStateProvider:Noop };
    if (name === '@utils/renderStatus') return { status:{3:'DELIVERED'} };
    if (name === '@utils/sendTelemetry') return { sendTelemetry: () => {} };
    if (name === '@utils/onWhatsappCache') return { saveOnWhatsappCache: async () => {} };
    if (name === '@utils/createJid') return { createJid: value => value };
    if (name === 'node-cache') return Noop;
    if (name === 'long') return { isLong:()=>false };
    if (name === 'baileys') return { getContentType:message=>Object.keys(message??{})[0],getDevice:()=> 'synthetic',default:()=>{throw Error('WHATSAPP_NETWORK_FORBIDDEN');} };
    if (name === 'axios') return { create: options => ({ post:async(_path,body)=>{ calls.push({kind:'legacy-http',destination:options.baseURL}); await onLegacyHttp(options.baseURL,body); } }) };
    const sink = /\/event\/(websocket|rabbitmq|nats|sqs|pusher|kafka)\//u.exec(name);
    if (sink) { const kind=sink[1], key=kind==='rabbitmq'?'Rabbitmq':kind==='websocket'?'Websocket':kind==='sqs'?'Sqs':kind[0].toUpperCase()+kind.slice(1); return { [`${key}Controller`]:class { async emit(data){calls.push({kind});await onSink(kind,data);} } }; }
    if (['child_process','crypto','os','path','stream','http'].includes(name)) return requireNative(name);
    // All remaining imports are fixture-only unused dependencies. Any accidental invocation throws.
    return {};
  }
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports:{} }; modules.set(path,module);
    const context = vm.createContext({ module,exports:module.exports,require:dependency,process,Buffer,console:{log: onConsole},setTimeout,clearTimeout,URL });
    vm.runInContext(codes[path],context,{filename:path}); return module.exports;
  }
  const { EventManager } = load('src/api/integrations/event/event.manager.ts');
  const manager = new EventManager(prisma,monitor); server.eventManager=manager; server.waMonitor=monitor;
  const { ChannelController } = load('src/api/integrations/channel/channel.controller.ts');
  const controller = new ChannelController(prisma,monitor), types = load('src/api/types/wa.types.ts');
  server.channelController = controller;
  async function createThroughApi(instanceName) {
    // Keep the real InstanceController -> ChannelController -> Baileys constructor
    // and setter sequence. Storage/settings ports are synthetic in this unit gate.
    monitor.saveInstance = async data => { calls.push({kind:'save-instance',id:data.instanceId}); };
    monitor.delInstanceTime = () => {};
    monitor.deleteInstance = name => { delete monitor.waInstances[name]; };
    manager.setInstance = async () => {};
    const { InstanceController } = load(apiPath);
    const api = new InstanceController(monitor,config,prisma,{}, {},{create:async()=>{}},{},{},{},{},{});
    const result = await api.createInstance({instanceName,integration:types.Integration.WHATSAPP_BAILEYS,qrcode:false});
    return {result,instance:monitor.waInstances[instanceName]};
  }
  function create(binding) {
    const scope = { instanceId:binding.instanceId,instanceName:binding.instanceName,integration:types.Integration.WHATSAPP_BAILEYS };
    const instance = controller.init(scope,{configService:config,eventEmitter:{},prismaRepository:prisma,cache:{},chatwootCache:{},baileysCache:{},providerFiles:{}});
    instance.setInstance(scope); monitor.waInstances[binding.instanceName]=instance;
    let callback, legacyPasses=0;
    instance.client={ev:{process:fn=>{callback=fn;}},profilePictureUrl:async()=>null}; instance.findSettings=async()=>({});
    if (!preserveMessageHandler) instance.messageHandle['messages.upsert']=async payload=>{
      // Match the pinned source: sendDataWebhook is fire-and-forget here.
      for(const message of payload.messages){legacyPasses++;const pending=instance.sendDataWebhook(types.Events.MESSAGES_UPSERT,instance.prepareMessage(message));pendingFanouts.add(pending);pending.then(()=>pendingFanouts.delete(pending),()=>pendingFanouts.delete(pending));}
    };
    instance.eventHandler();
    return { instance, async emit(events){await callback(events);await instance.eventProcessingQueue;}, get legacyPasses(){return legacyPasses;} };
  }
  // Observer only: tests may wait explicitly; the source handler never awaits it.
  async function drainFanouts(){while(pendingFanouts.size)await Promise.all([...pendingFanouts]);}
  return { create,createThroughApi,calls,errors,originals,prepared,codes,manager,drainFanouts };
}
