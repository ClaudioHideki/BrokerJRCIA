import {expect,it} from 'vitest';
const path='../../src/modules/channels/central-cutover-protocol.js';
const load=()=>import(path).catch(()=>null);
const initial={step:'DETACH',state:'PENDING',previousBotId:17,botId:null,callback:'https://broker.example.test/v1/integrations/chatwoot/synthetic/events',webhookFingerprint:'a'.repeat(64)};
it('does not attach the replacement until the previous inbox bot is observably absent',async()=>{
 const p=await load();expect(p).not.toBeNull();
 expect(p!.decideCentralCutover(initial,{botId:17,webhookFingerprint:initial.webhookFingerprint,bots:[]})).toEqual({action:'DETACH',next:'CREATE'});
 expect(p!.decideCentralCutover({...initial,state:'UNKNOWN'},{botId:17,webhookFingerprint:initial.webhookFingerprint,bots:[]})).toEqual({action:'WAIT'});
 expect(p!.decideCentralCutover({...initial,state:'UNKNOWN'},{botId:null,webhookFingerprint:initial.webhookFingerprint,bots:[]})).toEqual({action:'ADVANCE',next:'CREATE'});
});
it('reconciles uncertain bot creation by its unique callback and never repeats the POST',async()=>{
 const p=await load();expect(p).not.toBeNull();
 const op={...initial,step:'CREATE',state:'UNKNOWN'};
 expect(p!.decideCentralCutover(op,{botId:null,webhookFingerprint:initial.webhookFingerprint,bots:[]})).toEqual({action:'WAIT'});
 expect(p!.decideCentralCutover(op,{botId:null,webhookFingerprint:initial.webhookFingerprint,bots:[{id:19,outgoing_url:initial.callback,secret:'synthetic'}]})).toEqual({action:'ADOPT',next:'ATTACH',botId:19,secret:'synthetic'});
 expect(()=>p!.decideCentralCutover(op,{botId:null,webhookFingerprint:initial.webhookFingerprint,bots:[{id:19,outgoing_url:initial.callback,secret:'synthetic'},{id:20,outgoing_url:initial.callback,secret:'synthetic'}]})).toThrow('CENTRAL_BOT_AMBIGUOUS');
});
it('rejects changed webhooks or another bot instead of overwriting unrelated configuration',async()=>{
 const p=await load();expect(p).not.toBeNull();
 expect(()=>p!.decideCentralCutover(initial,{botId:17,webhookFingerprint:'b'.repeat(64),bots:[]})).toThrow('CENTRAL_REMOTE_CHANGED');
 expect(()=>p!.decideCentralCutover(initial,{botId:18,webhookFingerprint:initial.webhookFingerprint,bots:[]})).toThrow('CENTRAL_REMOTE_CHANGED');
});
it('requires the exact replacement bot, callback and signing secret before completion',async()=>{
 const p=await load();expect(p).not.toBeNull();const op={...initial,step:'ATTACH',state:'UNKNOWN',botId:19};
 const proof={botId:19,webhookFingerprint:initial.webhookFingerprint,bots:[{id:19,outgoing_url:initial.callback,secret:'synthetic'}]};
 expect(p!.decideCentralCutover(op,proof)).toEqual({action:'ADOPT',next:'VERIFY',botId:19,secret:'synthetic'});
 expect(p!.decideCentralCutover({...op,step:'VERIFY',state:'PENDING'},proof)).toEqual({action:'READY'});
 expect(()=>p!.decideCentralCutover({...op,step:'VERIFY',state:'PENDING'},{...proof,bots:[]})).toThrow('CENTRAL_BOT_UNVERIFIED');
});
