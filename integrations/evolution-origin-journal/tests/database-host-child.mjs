import {Pool} from 'pg';
import {compileEngineFixture} from './engine-fixture.mjs';
import {installOriginEngineDatabaseHost,prepareOriginEngineSocket} from '../src/engine-host.mjs';

// A real process boundary with the pinned callback and a synthetic native auth
// object. No WhatsApp socket, customer session or production endpoint is opened.
process.once('message',async input=>{
 let pool,host;
 try{
  const database=new URL(process.env.TEST_SOURCE_DATABASE_URL);
  if(!process.send||input?.kind!=='SYNTHETIC_DATABASE_HOST'||database.hostname!=='127.0.0.1'
   ||!/^\/jrc_test_[a-z0-9_]+$/u.test(database.pathname)||!/^jrc_origin_t_[a-f0-9]{12}$/u.test(database.username))throw Error();
  pool=new Pool({connectionString:database.href,max:2});process.env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED='true';
  host=await installOriginEngineDatabaseHost({pool,encryptionKey:Buffer.alloc(32,39),engine:input.engine,maxStagedBytes:1048576,
   brokerOrigin:'https://broker.example.test',env:{JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED:'true',HISTORY_SYNC_V2_ENABLED:'true'}});
  const fixture=await compileEngineFixture({endpoint:`https://broker.example.test/v1/webhooks/whatsapp/${input.channel}`,
   onLegacyHttp:async()=>{throw Error('Synthetic owned event reached legacy');}});
  const {instance,emit}=fixture.create({instanceId:input.nativeId,instanceName:input.instanceName,generation:1,destinationId:input.channel,revision:1});
  instance.instance.authState={state:{creds:{registrationId:2781,me:{id:`${input.phone}@s.whatsapp.net`}}}};
  await prepareOriginEngineSocket(instance);
  const message={key:{id:'synthetic-database-host-crash',remoteJid:`${input.phone}@s.whatsapp.net`,fromMe:false},
   messageTimestamp:1600000000,message:{conversation:'Synthetic host crash fact'}};
  if(input.mode==='LIVE_MEDIA'){
   const bytes=Buffer.from('synthetic source media after crash');
   const {createHash}=await import('node:crypto');
   message.message={imageMessage:{mediaKey:Buffer.alloc(32,17),fileSha256:createHash('sha256').update(bytes).digest(),
    fileLength:bytes.length,mimetype:'image/png',directPath:'/v/synthetic-live-crash.enc',caption:'Synthetic live caption'}};
   await emit({'messages.upsert':{type:'notify',messages:[message]}});
  }else await emit({'messages.upsert':{type:'notify',messages:[message]},'messaging-history.set':{chats:[],contacts:[],messages:[message]}});
  await fixture.drainFanouts();process.send({kind:'SOURCE_COMMITTED'});
  // Parent deliberately uses SIGKILL. This interval cannot be a persistence store.
  setInterval(()=>{},10000);
 }catch{
  process.send?.({kind:'SYNTHETIC_HOST_FAILED'});await host?.close().catch(()=>{});await pool?.end().catch(()=>{});process.exitCode=1;
  process.disconnect?.();
 }
});
