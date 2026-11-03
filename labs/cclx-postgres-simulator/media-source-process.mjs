import {fork} from 'node:child_process';
import {requireLabOnly,validateDatabaseUrl} from './state.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function validateSourceCrashFixture(options) {
 requireLabOnly(options);
 validateDatabaseUrl(options.database?.connectionString,true);
 try {
  const {database,scope,s3}=options,url=new URL(s3.endpoint);
  if(!['HOLD_AFTER_PUT','RECONCILE'].includes(options.mode??'HOLD_AFTER_PUT')||!uuid(database.token)||scope.organizationId!=='00000000-0000-4000-8000-000000000900'||!uuid(scope.channelId)||!uuid(scope.mediaId)||
   url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
   !s3.bucket.startsWith('cclx-lab-')||!uuid(s3.bucket.slice(9))||
   ![s3.accessKeyId,s3.secretAccessKey].every(value=>typeof value==='string'&&value.length>0&&value.length<=4096))throw Error();
 } catch {throw Error('INVALID_SOURCE_CRASH_FIXTURE');}
}

/** Start only our marked disposable source fixture, then hold immediately after
 * physical PUT. The returned handle can kill only this owned child process. */
export async function openSourceCrashProcess(options) {
 validateSourceCrashFixture(options);
 const child=fork(new URL('./media-source-process-child.mjs',import.meta.url),[],{
  execArgv:['--max-old-space-size=128'],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc'],
  env:{NODE_ENV:'test',...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},
 });
 let ended=false,timer,rejectPending;
 const exit=new Promise(resolve=>{
  const settle=(code,signal)=>{if(ended)return;ended=true;clearTimeout(timer);rejectPending?.(Error('SOURCE_CRASH_PROCESS_EXITED'));resolve({pid:child.pid,code,signal});};
  child.once('exit',settle);child.once('error',()=>settle(null,'SPAWN_ERROR'));
 });
 const crash=async()=>{if(!ended&&!child.kill('SIGKILL'))throw Error('SOURCE_CRASH_PROCESS_KILL_FAILED');return exit;};
 const finish=async()=>{
  let deadline;
  try{return await Promise.race([exit,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('SOURCE_CRASH_PROCESS_STOP_TIMEOUT')),5000);})]);}
  catch(error){await crash();throw error;}finally{clearTimeout(deadline);}
 };
 try {
  const observation=await new Promise((resolve,reject)=>{
   rejectPending=reject;timer=setTimeout(()=>reject(Error('SOURCE_CRASH_PROCESS_TIMEOUT')),20000);
   child.on('message',message=>{
    const held=(options.mode??'HOLD_AFTER_PUT')==='HOLD_AFTER_PUT'&&message?.kind==='PUT_PERSISTED'&&message.sourcePuts===1&&message.providerDownloads===1;
    const recovered=options.mode==='RECONCILE'&&message?.kind==='RECOVERY_COMPLETED'&&message.sourcePuts===0&&message.providerDownloads===0&&/^[a-f0-9]{64}$/.test(message.sha256);
    if(held||recovered){clearTimeout(timer);rejectPending=undefined;resolve(message);}
    else if(message?.kind==='FAILED')reject(Error('SOURCE_CRASH_PROCESS_FAILED'));
   });
   child.send(options,error=>{if(error)reject(Error('SOURCE_CRASH_PROCESS_IPC_FAILED'));});
  });
  return {pid:child.pid,observation,crash,finish,close:crash};
 } catch(error){await crash();throw error;}
}
