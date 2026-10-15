import {MediaError,validateMedia,type BinaryMedia} from './media.js';
export const SUPPORTED_UPLOAD_MIME_TYPES=['image/png','image/jpeg','audio/mpeg','audio/aac','audio/ogg','audio/mp4','video/mp4','video/3gpp','application/pdf','text/plain'] as const;
const starts=(data:Uint8Array,value:readonly number[])=>value.every((byte,index)=>data[index]===byte);
const ascii=(data:Uint8Array,from:number,to:number)=>new TextDecoder('ascii').decode(data.subarray(from,to));
function mp4Tracks(data:Uint8Array):Set<string>|null{
 const tracks=new Set<string>();let count=0,ftyp=false;
 const parse=(from:number,to:number,depth:number):boolean=>{if(depth>5)return false;let at=from;
  while(at<to){if(++count>2048||at+8>to)return false;const size=new DataView(data.buffer,data.byteOffset+at,4).getUint32(0);if(size<8||at+size>to)return false;const type=ascii(data,at+4,at+8);
   if(type==='ftyp'){if(depth!==0||size<20||size>256)return false;const brands=ascii(data,at+8,at+size);if(!/(?:isom|iso[2-9]|mp4[12]|M4[AV]|3gp[4-9]|qt  )/u.test(brands))return false;ftyp=true;}
   if(['moov','trak','mdia'].includes(type)){if(!parse(at+8,at+size,depth+1))return false;}
   if(type==='hdlr'){if(size<32)return false;const handler=ascii(data,at+16,at+20);if(['soun','vide'].includes(handler))tracks.add(handler);}
   at+=size;
  }return at===to;
 };return parse(0,data.length,0)&&ftyp&&tracks.size?tracks:null;
}
/** New UPLOAD only: historical provider assets preserve their validation contract. */
export function validateUploadMedia(file:BinaryMedia):void{
 if(!(SUPPORTED_UPLOAD_MIME_TYPES as readonly string[]).includes(file.mimeType))throw new MediaError('MEDIA_UPLOAD_TYPE_UNSUPPORTED');
 validateMedia(file);const data=file.bytes;let matched=false;
 switch(file.mimeType){
  case 'image/png':matched=data.length>=33&&starts(data,[137,80,78,71,13,10,26,10])&&ascii(data,12,16)==='IHDR';break;
  case 'image/jpeg':matched=data.length>=10&&starts(data,[255,216,255])&&data[data.length-2]===255&&data[data.length-1]===217;break;
  case 'application/pdf':matched=ascii(data,0,8).startsWith('%PDF-1.')&&ascii(data,Math.max(0,data.length-1024),data.length).trimEnd().endsWith('%%EOF');break;
  case 'text/plain':try{const text=new TextDecoder('utf-8',{fatal:true}).decode(data);matched=text.length>0&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);}catch{matched=false;}break;
  case 'audio/mpeg':matched=data.length>=4&&(starts(data,[73,68,51])&&data.length>=10||data[0]===255&&(data[1]!&224)===224&&(data[1]!&6)!==0);break;
  case 'audio/aac':matched=data.length>=7&&data[0]===255&&(data[1]!&246)===240;break;
  case 'audio/ogg':matched=data.length>=35&&ascii(data,0,4)==='OggS'&&data[4]===0&&data[26]!>0&&27+data[26]!<data.length&&(ascii(data,27+data[26]!,27+data[26]!+8)==='OpusHead'||ascii(data,28+data[26]!,28+data[26]!+6)==='vorbis');break;
  case 'audio/mp4':case 'video/mp4':case 'video/3gpp':{const tracks=mp4Tracks(data);matched=Boolean(tracks&&(file.kind==='audio'?tracks.has('soun')&&!tracks.has('vide'):tracks.has('vide')));break;}
 }
 if(!matched)throw new MediaError('MEDIA_SIGNATURE_MISMATCH');
}
