import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function parseOriginDatabaseHost(env){
  try{
    if(env.JRC_EVOLUTION_ORIGIN_JOURNAL_ENABLED!=='true'||env.HISTORY_SYNC_V2_ENABLED!=='true')throw Error();
    const database=new URL(env.JRC_ORIGIN_DATABASE_URL),origin=new URL(env.JRC_ORIGIN_BROKER_ORIGIN);
    if(!['postgres:','postgresql:'].includes(database.protocol)||!/^jrc_origin_[a-z0-9_]{1,48}$/u.test(decodeURIComponent(database.username))
      ||database.hash||database.search||origin.protocol!=='https:'||origin.username||origin.password||origin.origin!==env.JRC_ORIGIN_BROKER_ORIGIN
      ||!/^\/[a-zA-Z0-9_-]{1,63}$/u.test(database.pathname)||!database.hostname)throw Error();
    const key=env.JRC_ORIGIN_ENCRYPTION_KEY;
    if(typeof key!=='string'||!/^[A-Za-z\d+/]{43}=$/u.test(key))throw Error();
    const generation=Number(env.JRC_ORIGIN_ENGINE_GENERATION),maxStagedBytes=Number(env.HISTORY_SYNC_MAX_STAGED_BYTES??16777216);
    if(!Number.isSafeInteger(generation)||generation<1||generation>2147483647||!Number.isSafeInteger(maxStagedBytes)||maxStagedBytes<1||maxStagedBytes>128*1024*1024
      ||!/^[a-z][a-z0-9_-]{0,63}$/u.test(env.JRC_ORIGIN_ENGINE_ID??'')||!/^[a-f0-9]{64}$/u.test(env.JRC_ORIGIN_ENGINE_FINGERPRINT??''))throw Error();
    return{databaseUrl:database.href,encryptionKey:Buffer.from(key,'base64'),brokerOrigin:origin.origin,maxStagedBytes,
      engine:{engineId:env.JRC_ORIGIN_ENGINE_ID,generation,engineFingerprint:env.JRC_ORIGIN_ENGINE_FINGERPRINT}};
  }catch{throw Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');}
}

/** Invoke only AFTER the parent/child verified the complete runtime inventory. */
export async function openOriginDatabaseHost(root,env){
  const config=parseOriginDatabaseHost(env);
  const {Pool}=await import('pg');
  const pool=new Pool({connectionString:config.databaseUrl,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,statement_timeout:10000,
    application_name:'jrc-origin-source-v2'});
  pool.on('error',()=>{});let host;
  try{
    const {installOriginEngineDatabaseHost}=await import(pathToFileURL(join(root,'jrc-origin/engine-host.mjs')).href);
    host=await installOriginEngineDatabaseHost({...config,pool,env});
    return{async close(){try{await host.close();}finally{await pool.end();}}};
  }catch{await pool.end();throw Error('ORIGIN_ENGINE_OWNERSHIP_UNPROVEN');}
}
