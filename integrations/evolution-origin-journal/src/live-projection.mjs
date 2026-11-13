import {projectTextBatch} from './projection.mjs';

const individual=/^(?:[1-9]\d{7,14}(?::\d+)?@s\.whatsapp\.net|\d{1,30}(?::\d+)?@lid)$/u;
const group=/^\d+(?:-\d+)?@g\.us$/u;
const timestamp=value=>typeof value==='number'?value:value&&Number.isInteger(value.low)&&Number.isInteger(value.high)
 ? (value.low>>>0)+(value.high>>>0)*4294967296:NaN;
/** Operational V2 ownership of the facts accepted by Broker QR ingress. The
 * immutable journal carries no auth state, media keys, URL or quoted payload. */
export function projectLiveBatch(binding,events){
 const batch=events?.['messages.upsert'];if(!batch||batch.type!=='notify')return[];
 if(!Array.isArray(batch.messages)||batch.messages.length>100)throw Error('ORIGIN_LIVE_INVALID');
 return batch.messages.flatMap(item=>{
  const legacy=projectTextBatch(binding,{'messages.upsert':{type:'notify',messages:[item]}});
  if(legacy.length&&!item?.key?.remoteJidAlt&&!item?.key?.participant&&!item?.key?.participantAlt)return legacy;
  const key=item?.key,isGroup=typeof key?.remoteJid==='string'&&group.test(key.remoteJid);
  if(!key||!isGroup&&!individual.test(key.remoteJid??''))return[];
  let body=item.message;for(let i=0;i<3&&body;i++){
   const wrapped=body.ephemeralMessage?.message??body.viewOnceMessage?.message??body.viewOnceMessageV2?.message??body.documentWithCaptionMessage?.message;
   if(!wrapped)break;body=wrapped;
  }
  if(!body||['protocolMessage','editedMessage','reactionMessage','senderKeyDistributionMessage'].some(field=>body[field]!==undefined))return[];
  const text=body.conversation??body.extendedTextMessage?.text;
  const mediaKind=['image','audio','video','document','sticker'].find(kind=>body[kind+'Message']);
  if(text===undefined&&!mediaKind)return[];
  const seconds=timestamp(item.messageTimestamp);
  if(typeof key.id!=='string'||!key.id.length||key.id.length>256||typeof key.fromMe!=='boolean'
   ||!Number.isSafeInteger(seconds)||seconds<=0||seconds>253402300799
   ||typeof binding?.instanceName!=='string'||!binding.instanceName.length||binding.instanceName.length>255)throw Error('ORIGIN_LIVE_INVALID');
  const projectedKey={id:key.id,fromMe:key.fromMe,remoteJid:key.remoteJid};
  for(const field of ['remoteJidAlt','participant','participantAlt'])if(key[field]!==undefined&&key[field]!==null){
   if(typeof key[field]!=='string'||key[field].length>128||!individual.test(key[field]))throw Error('ORIGIN_LIVE_INVALID');
   projectedKey[field]=key[field];
  }
  if(isGroup&&!key.fromMe&&!projectedKey.participant)throw Error('ORIGIN_LIVE_INVALID');
  let message;
  if(text!==undefined){if(typeof text!=='string'||!text.length||text.length>4096)throw Error('ORIGIN_LIVE_INVALID');message={conversation:text};}
  else{
   const raw=body[mediaKind+'Message'],media={};
   for(const [field,max]of[['caption',1024],['fileName',255],['mimetype',255]])if(raw[field]!==undefined){
    if(typeof raw[field]!=='string'||raw[field].length>max)throw Error('ORIGIN_LIVE_INVALID');media[field]=raw[field];
   }
   message={[mediaKind+'Message']:media};
  }
  return[{event:'messages.upsert',instance:binding.instanceName,data:{key:projectedKey,message,messageTimestamp:seconds}}];
 });
}
export function canonicalLive(binding,envelope){
 const selected=projectLiveBatch(binding,{'messages.upsert':{type:'notify',messages:[envelope?.data]}});
 if(selected.length!==1||envelope?.event!=='messages.upsert'||envelope?.instance!==binding.instanceName
  ||JSON.stringify(selected[0])!==JSON.stringify(envelope))throw Error('ORIGIN_LIVE_INVALID');
 return selected[0];
}
