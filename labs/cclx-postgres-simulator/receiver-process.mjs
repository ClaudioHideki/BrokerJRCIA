import {fork} from 'node:child_process';
import {requireLabOnly,validateDatabaseUrl,validateMediaState} from './state.mjs';

/** Real disposable receiver process, restricted to the existing synthetic fixtures. */
export async function openLabReceiverProcess(options) {
 requireLabOnly(options);
 validateDatabaseUrl(options.database?.connectionString,true);
 await validateMediaState(options.mediaState);
 const child=fork(new URL('./receiver-process-child.mjs',import.meta.url),[],{
  execArgv:['--max-old-space-size=128'],serialization:'advanced',
  stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,NODE_ENV:'test'},
 });
 const pending=new Map();let sequence=0,ended=false;
 const exit=new Promise(resolve=>{
  const settle=(code,signal)=>{
   if(ended)return;ended=true;
   for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('LAB_RECEIVER_PROCESS_EXITED'));}
   pending.clear();resolve({pid:child.pid,code,signal});
  };
  child.once('exit',settle);
  child.once('error',()=>settle(null,'SPAWN_ERROR'));
 });
 child.on('message',message=>{
  const item=pending.get(message?.id);if(!item)return;
  clearTimeout(item.timer);pending.delete(message.id);
  if(message.error)item.reject(Error('LAB_RECEIVER_OPERATION_FAILED'));else item.resolve(message.value);
 });
 const call=(method,argument,initialOptions)=>new Promise((resolve,reject)=>{
  if(ended||!child.connected){reject(Error('LAB_RECEIVER_PROCESS_EXITED'));return;}
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('LAB_RECEIVER_PROCESS_TIMEOUT'));},20000);
  pending.set(id,{resolve,reject,timer});
  child.send({id,method,argument,...(initialOptions?{options:initialOptions}:{})},error=>{
   if(!error||!pending.has(id))return;clearTimeout(timer);pending.delete(id);reject(Error('LAB_RECEIVER_IPC_FAILED'));
  });
 });
 const terminate=async()=>{
  if(!ended&&!child.kill('SIGKILL'))throw Error('LAB_RECEIVER_KILL_FAILED');
  return await exit;
 };
 try {
  await call('initialize',undefined,{
   labOnly:true,database:{connectionString:options.database.connectionString,token:options.database.token},
   mediaState:{directory:options.mediaState.directory,token:options.mediaState.token},
   s3:options.s3,partnerFixture:options.partnerFixture,
  });
 } catch(error){await terminate();throw error;}
 return {
  pid:child.pid,
  handle:argument=>call('handle',argument),
  readEvent:id=>call('readEvent',id),readMediaReceipt:id=>call('readMediaReceipt',id),stats:()=>call('stats'),
  crash:terminate,
  close:async()=>{if(ended)return;try{await call('close');await exit;}catch{await terminate();}},
 };
}
