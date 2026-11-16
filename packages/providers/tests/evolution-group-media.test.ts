import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {expect,it,vi} from 'vitest';
import * as providers from '../src/index.js';
import type {BinaryMedia} from '../src/media.js';
const group='120363999000001@g.us';
const config={baseUrl:'https://engine.example.test',apiKey:'synthetic-only',instanceKey:'synthetic-group'};
const context=()=>({organizationId:'synthetic-org',requestId:'synthetic-request',signal:new AbortController().signal,deadline:new Date(Date.now()+5000)});
const file=(kind:BinaryMedia['kind']='document'):BinaryMedia=>({bytes:new Uint8Array(Buffer.from('synthetic-private-group-bytes')),
 mimeType:({image:'image/png',audio:'audio/ogg',video:'video/mp4',document:'application/pdf',sticker:'image/webp'})[kind],kind,fileName:'synthetic-file',...(kind==='sticker'?{}:{caption:'c'.repeat(1024)})});
function sender(extra:Record<string,unknown>={}){
 const factory=(providers as unknown as Record<string,unknown>).createEvolutionGroupMediaSender;
 expect(typeof factory).toBe('function');
 return(factory as (options:unknown)=>{sendMedia(context:ReturnType<typeof context>,recipient:{kind:'GROUP';groupJid:string},media:BinaryMedia):Promise<{upstreamMessageId:string}>})({...config,...extra});
}
it.each(['image','audio','video','document','sticker'] as const)('sends %s to its explicit GROUP JID with exact private bytes and correlated receipt',async kind=>{
 const calls:{url:string;body:any;signal:AbortSignal;redirect:string}[]=[];
 const input=file(kind),digest=createHash('sha256').update(input.bytes).digest('hex');
 const port=sender({fetch:async(url:unknown,init:RequestInit)=>{calls.push({url:String(url),body:JSON.parse(String(init.body)),signal:init.signal!,redirect:init.redirect!});return Response.json({key:{id:'synthetic-ack',remoteJid:group,fromMe:true}});}});
 expect(await port.sendMedia(context(),{kind:'GROUP',groupJid:group},input)).toEqual({status:'ACCEPTED',upstreamMessageId:'synthetic-ack'});
 expect(calls).toHaveLength(1);const call=calls[0]!;expect(call.body.number).toBe(group);expect(call.redirect).toBe('error');
 expect(call.url).toContain(kind==='sticker'?'/message/sendSticker/':'/message/sendMedia/');
 expect(createHash('sha256').update(Buffer.from(call.body[kind==='sticker'?'sticker':'media'],'base64')).digest('hex')).toBe(digest);
 if(kind!=='sticker'){expect(call.body.caption).toBe(input.caption);expect(call.body.mimetype).toBe(input.mimeType);expect(call.body.fileName).toBe(kind==='image'?'image.jpg':'synthetic-file');}
});
it.each(['5511999999999','12345@lid','status@broadcast','120363999000001@g.us/path'])('refuses a non-GROUP recipient before network: %s',async groupJid=>{
 const transport=vi.fn();await expect(sender({fetch:transport}).sendMedia(context(),{kind:'GROUP',groupJid},file())).rejects.toMatchObject({code:'INVALID_QR_INPUT',uncertain:false});expect(transport).not.toHaveBeenCalled();
});
it.each([{id:'ack',remoteJid:'120363999000002@g.us',fromMe:true},{id:'ack',remoteJid:group,fromMe:false},{id:'',remoteJid:group,fromMe:true}])('keeps uncorrelated post-dispatch receipts UNKNOWN without another request: %#',async key=>{
 const transport=vi.fn().mockResolvedValue(Response.json({key}));await expect(sender({fetch:transport}).sendMedia(context(),{kind:'GROUP',groupJid:group},file())).rejects.toMatchObject({code:'QR_SEND_UNKNOWN',uncertain:true});expect(transport).toHaveBeenCalledOnce();
});
it('aborts a real stalled HTTP response without retransmitting',async()=>{
 let posts=0;const server=createServer(async(req,res)=>{posts++;for await(const _chunk of req){}res.writeHead(200);res.flushHeaders();});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{
  const address=server.address();if(!address||typeof address==='string')throw Error('missing listener');
  const port=sender({baseUrl:'http://127.0.0.1:'+address.port,timeoutMs:500});
  await expect(port.sendMedia(context(),{kind:'GROUP',groupJid:group},file())).rejects.toMatchObject({code:'QR_SEND_UNKNOWN',uncertain:true});expect(posts).toBe(1);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
it('does not dispatch an expired request or invalid media and snapshots bytes before HTTP yields',async()=>{
 const transport=vi.fn().mockResolvedValue(Response.json({key:{id:'ack',remoteJid:group,fromMe:true}}));
 const port=sender({fetch:transport});await expect(port.sendMedia({...context(),deadline:new Date(0)},{kind:'GROUP',groupJid:group},file())).rejects.toMatchObject({code:'QR_SEND_NOT_DISPATCHED',uncertain:false});
 await expect(port.sendMedia(context(),{kind:'GROUP',groupJid:group},{...file(),bytes:new Uint8Array()})).rejects.toMatchObject({code:'MEDIA_SIZE_LIMIT',uncertain:false});expect(transport).not.toHaveBeenCalled();
 const input=file(),original=new Uint8Array(input.bytes),pending=port.sendMedia(context(),{kind:'GROUP',groupJid:group},input);input.bytes.fill(0);await pending;
 expect(Buffer.from(JSON.parse(String(transport.mock.calls[0]![1]!.body)).media,'base64')).toEqual(Buffer.from(original));
});

it('refuses a captioned sticker before POST rather than silently discarding human text',async()=>{
 const transport=vi.fn().mockResolvedValue(Response.json({key:{id:'ack',remoteJid:group,fromMe:true}}));await expect(sender({fetch:transport}).sendMedia(context(),{kind:'GROUP',groupJid:group},{...file('sticker'),caption:'Human text'})).rejects.toMatchObject({code:'MEDIA_CAPTION_UNSUPPORTED',uncertain:false});expect(transport).not.toHaveBeenCalled();
});
