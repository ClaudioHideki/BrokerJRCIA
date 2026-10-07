import {z} from 'zod';
const remoteId=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const step=z.enum(['DETACH','CREATE','ATTACH','VERIFY']);
const operation=z.strictObject({step,state:z.enum(['PENDING','UNKNOWN']),previousBotId:remoteId.nullable(),botId:remoteId.nullable(),callback:z.url(),webhookFingerprint:z.string().regex(/^[a-f0-9]{64}$/)});
const proof=z.strictObject({botId:remoteId.nullable(),webhookFingerprint:z.string().regex(/^[a-f0-9]{64}$/),bots:z.array(z.object({id:remoteId,outgoing_url:z.string().nullable().optional(),secret:z.string().optional()})).max(1000)});
export type CentralCutoverStep=z.infer<typeof step>;
export type CentralCutoverDecision={action:'WAIT'}|{action:'READY'}|{action:'DETACH'|'CREATE'|'ATTACH'|'ADVANCE';next:CentralCutoverStep}|{action:'ADOPT';next:CentralCutoverStep;botId:number;secret:string};
/** Decide from authenticated GETs only. UNKNOWN never grants another POST. */
export function decideCentralCutover(raw:unknown,observed:unknown):CentralCutoverDecision{
 const op=operation.parse(raw),p=proof.parse(observed);
 if(p.webhookFingerprint!==op.webhookFingerprint)throw new Error('CENTRAL_REMOTE_CHANGED');
 if(op.step==='DETACH'){
  if(p.botId===null)return {action:'ADVANCE',next:'CREATE'};
  if(p.botId!==op.previousBotId)throw new Error('CENTRAL_REMOTE_CHANGED');
  return op.state==='UNKNOWN'?{action:'WAIT'}:{action:'DETACH',next:'CREATE'};
 }
 const matches=p.bots.filter(bot=>bot.outgoing_url===op.callback);
 if(matches.length>1)throw new Error('CENTRAL_BOT_AMBIGUOUS');
 const own=matches[0];
 if(own&&(!own.secret||own.secret.length>8192||op.botId!==null&&own.id!==op.botId))throw new Error('CENTRAL_BOT_UNVERIFIED');
 if(op.step==='CREATE'){
  if(p.botId!==null)throw new Error('CENTRAL_REMOTE_CHANGED');
  if(own)return {action:'ADOPT',next:'ATTACH',botId:own.id,secret:own.secret!};
  return op.state==='UNKNOWN'?{action:'WAIT'}:{action:'CREATE',next:'ATTACH'};
 }
 if(!own||own.id!==op.botId)throw new Error('CENTRAL_BOT_UNVERIFIED');
 if(op.step==='ATTACH'){
  if(p.botId===own.id)return {action:'ADOPT',next:'VERIFY',botId:own.id,secret:own.secret!};
  if(p.botId!==null)throw new Error('CENTRAL_REMOTE_CHANGED');
  return op.state==='UNKNOWN'?{action:'WAIT'}:{action:'ATTACH',next:'VERIFY'};
 }
 if(p.botId!==own.id)throw new Error('CENTRAL_REMOTE_CHANGED');
 return {action:'READY'};
}
