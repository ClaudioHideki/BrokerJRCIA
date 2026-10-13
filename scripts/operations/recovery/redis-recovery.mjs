import {RESP_TYPES} from 'redis';
import {planRedisRestore} from './recovery.mjs';

const numeric=v=>Number(Buffer.isBuffer(v)?v.toString():v);
const ms=t=>numeric(t[0])*1000+Math.floor(numeric(t[1])/1000);
const captureScript=`local t=redis.call('TIME');local result={t[1],t[2]};for _,key in ipairs(KEYS) do table.insert(result,redis.call('DUMP',key) or false);table.insert(result,redis.call('PTTL',key));end;return result`;
export async function captureRedisNamespace(client,{namespace}){
 if(!/^broker-c5-[a-z0-9-]{1,64}:$/.test(namespace??''))throw Error('RECOVERY_REDIS_SCOPE_INVALID');
 const keys=new Set();let cursor='0';do{const page=await client.scan(cursor,{MATCH:namespace+'*',COUNT:64});cursor=String(page.cursor);for(const key of page.keys){if(!key.startsWith(namespace)||key.length>256)throw Error('RECOVERY_REDIS_SCOPE_INVALID');keys.add(key);if(keys.size>128)throw Error('RECOVERY_LIMIT_EXCEEDED');}}while(cursor!=='0');
 const ordered=[...keys].sort(),capturedHostMs=Date.now(),binary=client.withTypeMapping({[RESP_TYPES.BLOB_STRING]:Buffer}),result=await binary.eval(captureScript,{keys:ordered});
 return{namespace,capturedHostMs,capturedRedisMs:ms(result),keys:ordered.map((key,i)=>({key,dump:result[2+i*2]===null?null:Buffer.from(result[2+i*2]).toString('base64'),pttl:numeric(result[3+i*2])}))};
}
const restoreScript=`for _,key in ipairs(KEYS) do if redis.call('EXISTS',key)==1 then return redis.error_reply('RECOVERY_REDIS_TARGET_NOT_EMPTY') end end;local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000);if now<tonumber(ARGV[1]) then return redis.error_reply('RECOVERY_CLOCK_REGRESSION') end;local restored=0;local persistent=0;local expiring=0;local expired=0;for i,key in ipairs(KEYS) do local deadline=tonumber(ARGV[i*2]);if deadline==0 then redis.call('RESTORE',key,0,ARGV[i*2+1]);restored=restored+1;persistent=persistent+1;elseif deadline>now then redis.call('RESTORE',key,deadline,ARGV[i*2+1],'ABSTTL');restored=restored+1;expiring=expiring+1;else expired=expired+1;end end;return {restored,persistent,expiring,expired}`;
export async function restoreRedisNamespace(client,snapshot){
 const observed=ms(await client.sendCommand(['TIME'])),plan=planRedisRestore(snapshot,{hostNowMs:Date.now(),redisNowMs:observed});
 let result;try{result=await client.eval(restoreScript,{keys:plan.map(r=>r.key),arguments:[String(observed),...plan.flatMap(r=>[String(r.ttlMs===0?0:observed+r.ttlMs),r.dump])]});}catch(e){throw Error(e?.message?.includes('RECOVERY_REDIS_TARGET_NOT_EMPTY')?'RECOVERY_REDIS_TARGET_NOT_EMPTY':e?.message?.includes('RECOVERY_CLOCK_REGRESSION')?'RECOVERY_CLOCK_REGRESSION':'RECOVERY_REDIS_RESTORE_FAILED');}
 return{restoredKeys:numeric(result[0]),persistentKeys:numeric(result[1]),expiringKeys:numeric(result[2]),expiredKeys:snapshot.keys.length-plan.length+numeric(result[3]),scope:'LIMITED_NAMESPACE'};
}
