import {it,expect,vi} from 'vitest';import {dispatchClaim} from '../../../src/modules/messaging/dispatcher.js';
it.each(['EVOLUTION_ENGINE_DISABLED','EVOLUTION_ENGINE_BINDING_CHANGED','EVOLUTION_ENGINE_RETRY_LATER'])('records known pre-dispatch %s as FAILED rather than a fictitious UNKNOWN',async code=>{
 const complete=vi.fn(),claim:any={channel:{provider:'BAILEYS'},message:{content:{type:'TEXT',text:'Synthetic'}},contact:{externalId:'15550000001'}};
 await dispatchClaim(claim,{validate:async()=>true,resolveClient:async()=>({sendText:async()=>{throw Object.assign(new Error(code),{code,uncertain:false});},listTemplates:vi.fn(),sendTemplate:vi.fn()}),complete});
 expect(complete).toHaveBeenCalledWith(claim,{state:'FAILED',canonicalErrorCode:code,retrySafe:code==='EVOLUTION_ENGINE_RETRY_LATER'});
});
