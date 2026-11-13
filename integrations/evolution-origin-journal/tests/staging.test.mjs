import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile,access } from 'node:fs/promises';
import { stagePinnedEngine, removeOwnStage } from '../build/stage-engine.mjs';
test('full source staging copies pinned overlays, runtime and legal provenance without editing vendor',async()=>{
 const stage=await stagePinnedEngine();
 try{
  const config=JSON.parse(await readFile(stage.directory+'/tsconfig.json','utf8'));
  assert.deepEqual(config.compilerOptions.paths['@jrc-origin/*'],['./jrc-origin/*']);
  const factory=await readFile(stage.directory+'/src/api/integrations/channel/channel.controller.ts','utf8');
  assert.match(factory,/attachOriginEngineInstance\(instanceData, new BaileysStartupService/u);
  assert.match(await readFile(stage.directory+'/src/api/services/channel.service.ts','utf8'),/await trackOriginEngineFanout\(this, \(\) => eventManager\.emit\(/u);
  assert.equal(stage.manifest.deliveryOwnership,'UNPROVEN');
  assert.deepEqual(stage.manifest.patches.map(patch=>patch.path).sort(),[
   'src/main.ts','src/api/repository/repository.service.ts','src/cache/rediscache.client.ts',
   'src/api/controllers/instance.controller.ts','src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
   'src/api/integrations/channel/channel.controller.ts','src/api/services/channel.service.ts','src/api/services/monitor.service.ts',
   'src/api/integrations/event/webhook/webhook.controller.ts','src/api/integrations/event/event.manager.ts',
   'src/api/integrations/event/event.controller.ts','src/api/types/wa.types.ts',
  ].sort());
  assert.ok(stage.manifest.sourceFileCount>100);
  assert.ok(await readFile(stage.directory+'/jrc-origin/engine-host.mjs','utf8'));
  await assert.rejects(access(stage.directory+'/src/schema/origin-journal.sql'));
  await assert.rejects(access(stage.directory+'/jrc-origin/engine-overlay.mjs'));
  assert.ok(stage.manifest.legalFiles.includes('LICENSE'));
  assert.match(await readFile(stage.directory+'/tsup.config.ts','utf8'),/entry: \['src\/main.ts'\]/u);
 }finally{await removeOwnStage(stage.directory);}
});
