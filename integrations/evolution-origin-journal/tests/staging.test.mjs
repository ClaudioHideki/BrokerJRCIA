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
  assert.equal(stage.manifest.deliveryOwnership,'UNPROVEN');assert.equal(stage.manifest.patches.length,7);assert.ok(stage.manifest.sourceFileCount>100);
  assert.ok(await readFile(stage.directory+'/jrc-origin/engine-host.mjs','utf8'));
  await assert.rejects(access(stage.directory+'/src/schema/origin-journal.sql'));
  await assert.rejects(access(stage.directory+'/jrc-origin/engine-overlay.mjs'));
  assert.ok(stage.manifest.legalFiles.includes('LICENSE'));
  assert.match(await readFile(stage.directory+'/tsup.config.ts','utf8'),/entry: \['src\/main.ts'\]/u);
 }finally{await removeOwnStage(stage.directory);}
});
