import {z} from 'zod';

export const PartnerAckModeSchema=z.enum(['HTTP','PERSISTENCE_RECEIPT_V1']);
export type PartnerAckMode=z.infer<typeof PartnerAckModeSchema>;
// The receipt attests receiver persistence only. It does not assert processing,
// WhatsApp delivery, media custody or durability of the receiver's storage.
export const PartnerPersistenceReceiptSchema=z.strictObject({
 schemaVersion:z.literal(1),contract:z.literal('PERSISTENCE_RECEIPT_V1'),
 eventId:z.uuid(),deliveryId:z.uuid(),organizationId:z.uuid(),endpointId:z.uuid(),
 receiptId:z.uuid(),persistedAt:z.iso.datetime(),
});
export type PartnerPersistenceReceipt=z.infer<typeof PartnerPersistenceReceiptSchema>;

export async function readPartnerPersistenceReceipt(response:Response,signal:AbortSignal):Promise<PartnerPersistenceReceipt>{
 if(!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??'')||!response.body||Number(response.headers.get('content-length'))>65536){void response.body?.cancel().catch(()=>{});throw new Error('PERSISTENCE_RECEIPT_INVALID');}
 const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 let abort:()=>void=()=>{};const aborted=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new Error('PERSISTENCE_RECEIPT_INVALID'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
 try{
  for(;;){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;size+=part.value.byteLength;if(size>65536)throw new Error('PERSISTENCE_RECEIPT_INVALID');chunks.push(part.value);}
  return PartnerPersistenceReceiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
 }finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});}
}
