import {spawn} from 'node:child_process';
import pg from 'pg';

const MAX_BYTES=64*1024*1024;
export function validateLabDatabase(databaseUrl){
 let u;try{u=new URL(databaseUrl);}catch{throw Error('RECOVERY_LAB_DATABASE_REQUIRED');}
 if(!['postgresql:','postgres:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!/^\/jrc_test_[0-9]+_[a-f0-9]{32}$/.test(u.pathname)||u.search||u.hash)throw Error('RECOVERY_LAB_DATABASE_REQUIRED');
 return{database:u.pathname.slice(1),env:{...process.env,PGHOST:u.hostname.replace(/^\[|\]$/g,''),PGPORT:u.port||'5432',PGDATABASE:u.pathname.slice(1),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGCONNECT_TIMEOUT:'5'}};
}
function child(executable,args,env,input){return new Promise((resolve,reject)=>{
 const chunks=[];let size=0,settled=false;
 const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(Error(error)):resolve(value);};
 const p=spawn(executable,args,{env,windowsHide:true,stdio:['pipe','pipe','pipe']}),timer=setTimeout(()=>{p.kill();done('RECOVERY_POSTGRES_TIMEOUT');},120000);
 p.on('error',()=>done('RECOVERY_POSTGRES_EXECUTION_FAILED'));p.stdout.on('data',b=>{size+=b.length;if(size>MAX_BYTES){p.kill();done('RECOVERY_LIMIT_EXCEEDED');}else chunks.push(b);});
 p.stderr.on('data',()=>{});p.stdin.on('error',()=>{});p.on('close',code=>done(code===0?null:'RECOVERY_POSTGRES_EXECUTION_FAILED',Buffer.concat(chunks)));p.stdin.end(input);
});}
export async function capturePostgresDump({databaseUrl,executable}){
 const t=validateLabDatabase(databaseUrl),dump=await child(executable,['--format=custom','--no-password','--dbname',t.database],t.env);
 if(dump.length<5||dump.subarray(0,5).toString()!=='PGDMP')throw Error('RECOVERY_POSTGRES_DUMP_INVALID');return dump;
}
export async function restorePostgresDump({databaseUrl,executable,dump}){
 const t=validateLabDatabase(databaseUrl);if(!Buffer.isBuffer(dump)||dump.length>MAX_BYTES||dump.subarray(0,5).toString()!=='PGDMP')throw Error('RECOVERY_POSTGRES_DUMP_INVALID');
 await assertEmptyPostgres(databaseUrl);
 await child(executable,['--exit-on-error','--single-transaction','--no-password','--dbname',t.database],t.env,dump);return{restored:true};
}
export async function assertEmptyPostgres(databaseUrl){
 validateLabDatabase(databaseUrl);
 const db=new pg.Client({connectionString:databaseUrl,connectionTimeoutMillis:5000,statement_timeout:10000});
 try{await db.connect();const result=await db.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')) AS occupied");if(result.rows[0].occupied)throw Error('RECOVERY_POSTGRES_TARGET_NOT_EMPTY');}
 catch(e){if(e?.message==='RECOVERY_POSTGRES_TARGET_NOT_EMPTY')throw e;throw Error('RECOVERY_POSTGRES_PREFLIGHT_FAILED');}finally{await db.end();}
}
