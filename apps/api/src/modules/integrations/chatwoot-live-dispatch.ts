import {ChatwootClient,ChatwootError} from './chatwoot-client.js';
import {LIVE_INGRESS_PROTOCOL,liveIngressLookup,liveIngressProofSchema,
 type LiveIngressProof,type LiveIngressRequest,type LiveIngressScope,type LiveIngressReceipt} from './chatwoot-live-ingress.js';
import {IntegrationError} from './integration-error.js';
import type {BinaryMedia} from '@jrc/providers';
interface Selection {client:ChatwootClient;scope:LiveIngressScope|undefined;accountId:number;inboxId:number;
 recorded?:unknown;hasPriorAttempt:boolean;operation?:unknown}
export async function selectLiveMirrorProtocol(input:Selection):Promise<'GENERIC'|typeof LIVE_INGRESS_PROTOCOL>{
 if(input.recorded==='GENERIC')return 'GENERIC';
 if(input.recorded===LIVE_INGRESS_PROTOCOL){
  if(!input.scope)throw new IntegrationError('CHATWOOT_LIVE_CONTEXT_CHANGED',409);
  return LIVE_INGRESS_PROTOCOL;
 }
 if(input.recorded!==undefined)throw new IntegrationError('CHATWOOT_LIVE_PROTOCOL_CONFLICT',409);
 // A capability introduced later cannot retrospectively turn a generic POST
 // into an idempotent native one. Persist this choice with the mirror attempt.
 if(!input.scope||input.hasPriorAttempt||['SEND_MESSAGE','GROUP_SEND_MESSAGE'].includes(String(input.operation)))return 'GENERIC';
 return await input.client.liveIngress().capability(input.accountId,input.inboxId,input.scope)?LIVE_INGRESS_PROTOCOL:'GENERIC';
}
interface Dispatch {client:ChatwootClient;body:LiveIngressRequest;proof:LiveIngressProof;file?:BinaryMedia;
 accountId?:number;pin(value:LiveIngressProof):Promise<void>;
 guard?<T>(operation:'PERSIST'|'RECEIPT',mutation:boolean,work:()=>Promise<T>):Promise<T>}
export function assertRejectedNativeRetry(value:unknown,body:LiveIngressRequest,
 context:{account_id:number;inbox_id:number;credential_revision:number;base_url:string},state:unknown):void{
 const parsed=liveIngressProofSchema.safeParse(value);
 if(!parsed.success||state!=='REJECTED'||parsed.data.receipt_id!==undefined)
  throw new ChatwootError('CHATWOOT_LIVE_CONFIRMATION_PENDING',false,true);
 const proof=parsed.data,expected=liveIngressLookup(body),actual=liveIngressLookup(proof);
 if(Object.keys(expected).some(key=>expected[key as keyof typeof expected]!==actual[key as keyof typeof actual])
  ||Object.keys(context).some(key=>context[key as keyof typeof context]!==proof[key as keyof typeof context]))
  throw new IntegrationError('CHATWOOT_LIVE_REQUEST_CONFLICT',409);
}
export async function dispatchNativeLiveMirror(input:Dispatch):Promise<number>{
 let proof=liveIngressProofSchema.parse(input.proof);
 const expected=liveIngressLookup(input.body),actual=liveIngressLookup(proof);
 if((input.accountId!==undefined&&input.accountId!==proof.account_id)
  ||Object.keys(expected).some(key=>expected[key as keyof typeof expected]!==actual[key as keyof typeof actual]))
  throw new IntegrationError('CHATWOOT_LIVE_REQUEST_CONFLICT',409);
 const native=input.client.liveIngress();
 const guarded=<T>(operation:'PERSIST'|'RECEIPT',mutation:boolean,work:()=>Promise<T>)=>input.guard?input.guard(operation,mutation,work):work();
 const accept=async(receipt:LiveIngressReceipt)=>{
  if(proof.receipt_id!==undefined&&proof.receipt_id!==receipt.receipt_id)
   throw new ChatwootError('CHATWOOT_LIVE_RECEIPT_ID_CHANGED',false,true);
  if(proof.receipt_id===undefined){
   proof={...proof,receipt_id:receipt.receipt_id};
   try{await input.pin(proof);}
   catch{throw new ChatwootError('CHATWOOT_LIVE_CONFIRMATION_PENDING',false,true);}
  }
  return receipt.state==='PERSISTED'?receipt.message_id:null;
 };
 let response:LiveIngressReceipt|undefined;
 try{response=await guarded('PERSIST',true,()=>native.persist(proof.account_id,proof.inbox_id,input.body,input.file));}
 catch(error){if(!(error instanceof ChatwootError)||!error.uncertain)throw error;}
 if(response){const id=await accept(response);if(id!==null)return id;}
 // This is a read of the durable receiver, not another message POST. A read
 // failure or missing/pending custody never releases the uncertain operation.
 let recovered:LiveIngressReceipt|null;
 try{recovered=await guarded('RECEIPT',false,()=>native.receipt(proof.account_id,proof.inbox_id,proof));}
 catch{throw new ChatwootError('CHATWOOT_LIVE_CONFIRMATION_PENDING',false,true);}
 if(recovered){const id=await accept(recovered);if(id!==null)return id;}
 throw new ChatwootError('CHATWOOT_LIVE_CONFIRMATION_PENDING',false,true);
}
