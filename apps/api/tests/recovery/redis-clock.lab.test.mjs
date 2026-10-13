import {randomUUID} from 'node:crypto';
import {createClient} from 'redis';
import {expect,it} from 'vitest';
import {captureRedisNamespace,restoreRedisNamespace} from '../../../../scripts/operations/recovery/redis-recovery.mjs';

it('refuses a Redis clock that moves backwards between preflight and actual restore without reinstating even a persistent key',async()=>{
 if(!process.env.TEST_REDIS_URL)throw Error('RECOVERY_TEST_ENV_REQUIRED:TEST_REDIS_URL');
 const namespace='broker-c5-clock-'+randomUUID().replaceAll('-','')+':',key=namespace+'persistent';
 const client=createClient({url:process.env.TEST_REDIS_URL,socket:{connectTimeout:5000,reconnectStrategy:false}});client.on('error',()=>{});
 try{
  await client.connect();await client.set(key,'synthetic-clock-observation');const snapshot=await captureRedisNamespace(client,{namespace});await client.del(key);
  const clockJump={sendCommand:async args=>{const t=await client.sendCommand(args);return[String(Number(t[0])+60),t[1]];},eval:(...args)=>client.eval(...args)};
  await expect(restoreRedisNamespace(clockJump,snapshot)).rejects.toThrow('RECOVERY_CLOCK_REGRESSION');expect(await client.get(key)).toBeNull();
 }finally{if(client.isOpen){await client.del(key);await client.quit();}}
});
