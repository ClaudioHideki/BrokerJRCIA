import { Pool } from 'pg';
import { createOriginJournal } from '../src/journal.mjs';
import { withOriginEngineLabHost,awaitOriginEngineReady } from '../src/engine-host.mjs';
import { compileEngineFixture } from './engine-fixture.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';
import { source } from './fixtures.mjs';
process.once('message',async config=>{
 let pool;
 try{
  validateTestAdminUrl(config.connectionString);process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED='true';
  pool=new Pool({connectionString:config.connectionString,max:3,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:6000});
  const journal=createOriginJournal({pool,encryptionKey:Buffer.from(config.key,'hex')});
  const fixture=await compileEngineFixture({endpoint:config.endpoint,onLegacyHttp:async()=>{throw Error('OWNED_LEGACY_HTTP_FORBIDDEN');}});
  const capturedJournal=config.mode==='source-before-dispatch'?{...journal,async acceptBatch(...args){const result=await journal.acceptBatch(...args);process.send({phase:'SOURCE_COMMITTED'});await new Promise(()=>{});return result;}}:journal;
  await withOriginEngineLabHost({labOnly:true,env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true'},prepareInstance:async()=>({pool,journal:capturedJournal,binding:config.binding,resolveBinding:async()=>config.binding,
   transport:{endpoint:config.endpoint,bearerToken:config.bearerToken,allowInsecureLoopbackForTests:true},dispatch:{timeoutMs:5000},worker:{maxIterations:1}})},async()=>{
   const engine=fixture.create(config.binding),composition=await awaitOriginEngineReady(engine.instance);
   if(config.mode!=='replay'){
    const events={'messages.upsert':source(config.providerId)['messages.upsert']};
    await engine.emit(events);
    process.send({phase:'SOURCE_PROCESSED',legacyPasses:engine.legacyPasses,legacyHttp:fixture.calls.filter(call=>call.kind==='legacy-http').length,errors:fixture.errors.length});
   }
   await composition.start();await composition.stop();
   process.send({phase:'REPLAY_FINISHED',legacyPasses:engine.legacyPasses,legacyHttp:fixture.calls.filter(call=>call.kind==='legacy-http').length,errors:fixture.errors.length});
  });
  await pool.end();pool=undefined;process.disconnect();
 }catch(error){await pool?.end().catch(()=>{});process.send({phase:'CHILD_FAILED',code:typeof error?.message==='string'&&/^[A-Z_]+$/u.test(error.message)?error.message:'ENGINE_FIXTURE_FAILED'});process.exitCode=1;process.disconnect();}
});
