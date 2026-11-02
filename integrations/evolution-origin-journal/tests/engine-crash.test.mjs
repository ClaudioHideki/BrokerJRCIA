import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { validatorCompiler,serializerCompiler } from 'fastify-type-provider-zod';
import { runMigrations } from '../../../apps/api/dist/db/migrate.js';
import { withOrganizationTransaction } from '../../../apps/api/dist/db/tenant-transaction.js';
import { createQrMessagingService,ensureQrChannel } from '../../../apps/api/dist/modules/messaging/qr-service.js';
import { registerIntegrationRoutes } from '../../../apps/api/dist/http/routes/integrations.js';
import { installOriginJournal } from '../src/journal.mjs';
import { validateTestAdminUrl } from './lab-database.mjs';

test('compiled pinned engine composition SIGKILL before dispatch and after actual Broker COMMIT recovers without legacy replay',{timeout:180000},async()=>{
 const target=validateTestAdminUrl(process.env.TEST_DATABASE_ADMIN_URL),admin=new Pool({connectionString:target.href,max:1}),databases=[],pools=[],children=new Set();
 let app,releaseAck;
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function kill(child){const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);assert.deepEqual(await exited,[null,'SIGKILL']);children.delete(child);}
 try{
  async function database(){const name=`jrc_test_origin_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${name}"`);databases.push(name);const url=new URL(target);url.pathname=`/${name}`;return url;}
  const originUrl=await database(),brokerUrl=await database(),lock=await admin.connect();
  try{await lock.query("SELECT pg_advisory_lock(hashtextextended('jrc-test-global-roles',0))");await runMigrations(brokerUrl.href);}finally{await lock.query("SELECT pg_advisory_unlock(hashtextextended('jrc-test-global-roles',0))");lock.release();}
  const originPool=new Pool({connectionString:originUrl.href,max:2,connectionTimeoutMillis:3000,statement_timeout:10000}),brokerAdmin=new Pool({connectionString:brokerUrl.href,max:1});pools.push(originPool,brokerAdmin);
  const appUrl=new URL(brokerUrl);appUrl.username='jrc_app';appUrl.password='';const appPool=new Pool({connectionString:appUrl.href,max:2});pools.push(appPool);
  await installOriginJournal(originPool);
  const org=randomUUID(),engine=`synthetic-engine-${randomUUID()}`,actor=randomUUID();
  const seed=await brokerAdmin.connect();try{await seed.query('BEGIN');await seed.query("INSERT INTO organizations(id,name,slug) VALUES($1,'Synthetic compiled origin',$2)",[org,engine]);await seed.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'synthetic-test-only')",[actor,`${actor}@example.test`]);await seed.query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'OWNER')",[org,actor]);await seed.query('COMMIT');}catch(error){await seed.query('ROLLBACK');throw error;}finally{seed.release();}
  const provider=(await brokerAdmin.query("INSERT INTO provider_accounts(organization_id,provider,name) VALUES($1,'BAILEYS','Synthetic engine') RETURNING id",[org])).rows[0].id;
  const instance=(await brokerAdmin.query("INSERT INTO instances(organization_id,provider_account_id,name,upstream_instance_key,status) VALUES($1,$2,'Synthetic engine',$3,'CONNECTED') RETURNING id",[org,provider,engine])).rows[0].id;
  const transact=(organization,work)=>withOrganizationTransaction(appPool,organization,work),channel=(await transact(org,tx=>ensureQrChannel(tx,org,instance))).id;
  const binding={instanceId:instance,instanceName:engine,generation:1,destinationId:channel,revision:1},key=randomBytes(32),signingKey='synthetic-compiled-engine-signing-key-'.repeat(2),bearerToken=createHmac('sha256',signingKey).update(`qr-webhook\0${org}\0${channel}`).digest('base64url');
  const qr=createQrMessagingService({baseUrl:'https://synthetic-engine.invalid',apiKey:'synthetic-test-only',webhookOrigin:'https://synthetic-broker.invalid',signingKey,transact,resolveChannel:async id=>id===channel?{organizationId:org,instanceId:instance}:undefined});
  app=Fastify({logger:false});app.setValidatorCompiler(validatorCompiler);app.setSerializerCompiler(serializerCompiler);
  let hold=false,committedResolve;
  app.addHook('onSend',async(_request,reply,payload)=>{if(hold&&reply.statusCode===200){hold=false;committedResolve(JSON.parse(payload));await new Promise(resolve=>{releaseAck=resolve;});}return payload;});
  await registerIntegrationRoutes(app,{qr,jwtSecret:'synthetic-test-only',authenticateApiKey:async()=>null,resolveCurrentRole:async()=>null});
  const address=await app.listen({host:'127.0.0.1',port:0}),endpoint=`${address}/v1/webhooks/whatsapp/${channel}`;
  function child(mode,providerId){const child=fork(new URL('./engine-crash-child.mjs',import.meta.url),[],{stdio:['ignore','ignore','inherit','ipc']});children.add(child);child.send({mode,providerId,connectionString:originUrl.href,key:key.toString('hex'),binding,endpoint,bearerToken});return child;}
  async function phase(child,expected){const [message]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.equal(message.phase,expected,JSON.stringify(message));return message;}
  const count=async table=>Number((await brokerAdmin.query(`SELECT count(*) AS n FROM ${table} WHERE channel_id=$1`,[channel])).rows[0].n);
  for(const [index,boundary] of ['source-before-dispatch','recipient-before-ack'].entries()){
   const providerId=`synthetic-${boundary}`;
   const committed=boundary==='recipient-before-ack'?new Promise(resolve=>{hold=true;committedResolve=resolve;}):null;
   const source=child(boundary,providerId);
   const observed=await phase(source,boundary==='source-before-dispatch'?'SOURCE_COMMITTED':'SOURCE_PROCESSED');
   if(boundary==='recipient-before-ack'){
    assert.equal(observed.legacyPasses,1);assert.equal(observed.legacyHttp,0);assert.equal(observed.errors,0);
    let timer;try{const receipt=await Promise.race([committed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('BROKER_COMMIT_NOT_OBSERVED')),15000);})]);assert.equal(receipt.durablyAccepted,true);}finally{clearTimeout(timer);}
    assert.equal(await count('messaging_messages'),index+1);assert.equal(await count('qr_origin_receipts'),index+1);
   }
   await kill(source);releaseAck?.();releaseAck=undefined;
   const row=(await originPool.query("SELECT id,state,lease_until FROM jrc_evolution_origin.events WHERE state<>'DELIVERED' ORDER BY source_sequence LIMIT 1")).rows[0];assert.ok(row);
   if(boundary==='source-before-dispatch')assert.equal(row.state,'PENDING');
   if(row.lease_until)await sleep(Math.max(0,new Date(row.lease_until).getTime()-Date.now())+50);
   const replay=child('replay',providerId),exited=once(replay,'exit'),result=await phase(replay,'REPLAY_FINISHED');
   assert.equal(result.legacyPasses,0);assert.equal(result.legacyHttp,0);assert.equal(result.errors,0);assert.deepEqual(await exited,[0,null]);children.delete(replay);
   assert.equal((await originPool.query('SELECT state FROM jrc_evolution_origin.events WHERE id=$1',[row.id])).rows[0].state,'DELIVERED');
   assert.equal(await count('messaging_messages'),index+1);assert.equal(await count('qr_origin_receipts'),index+1);
  }
 }finally{
  for(const child of children)await kill(child);releaseAck?.();await app?.close();for(const pool of pools.reverse())await pool.end();
  try{for(const name of databases.reverse())if(/^jrc_test_origin_[a-f0-9]{32}$/u.test(name))await admin.query(`DROP DATABASE "${name}"`);}finally{await admin.end();}
 }
});
