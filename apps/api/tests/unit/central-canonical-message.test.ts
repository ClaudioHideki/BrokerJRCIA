import { expect,it,vi } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
const reviewIdentity={broker:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',provider:'whatsapp-test-id',org:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
it.each(['canonical','provider','partial','repeated','lostAnchor','absent'])('checks legacy mirror history across pages (%s)',async mode=>{
 const identity=reviewIdentity,latest={id:42,conversation_id:51,inbox_id:9,created_at:125,source_id:null,content_attributes:{}};
 const older={...latest,id:60,created_at:100,source_id:mode==='provider'?identity.provider:null,
   content_attributes:mode==='canonical'?{jrc_broker_message_id:identity.broker.toUpperCase()}:{}};
 const calls:string[]=[];
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async input=>{
   const {searchParams:q,search}=new URL(String(input));calls.push(search);
   if(!search)return Response.json({payload:[latest]});
   if(q.get('before')==='42'){
     if(mode==='partial')return Response.json({payload:[]},{status:206});
     return Response.json({payload:[mode==='repeated'?latest:older]});
   }
   if(q.get('after')==='60')return Response.json({payload:mode==='lostAnchor'?[]:[older]});
   return Response.json({payload:[]});
 }});
 const lookup=client.reviewMirrorHistory(7,9,51,identity.broker,identity.provider,identity.org);
 if(mode==='absent'){
   await expect(lookup).resolves.toBeUndefined();
   expect(calls).toEqual(['','?before=42','?before=60','?after=60&before=61','']);
 }else{
   await expect(lookup).rejects.toThrow();
   expect(calls).toContain('?before=42');
 }
});
const message={id:41,conversation_id:51,account_id:7,inbox_id:9,message_type:0,private:false,content:'Synthetic input',content_type:'text',sender:{id:31,type:'contact'},created_at:100};
it('finds the exact message when chronological pagination requires an existing cursor',async()=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async input=>{
  const query=new URL(String(input)).searchParams;
  return Response.json({payload:query.get('after')==='41'&&query.get('before')==='42'?[message]:[]});
 }});
 await expect(client.canonicalMessage(7,9,51,41)).resolves.toMatchObject({id:41});
});
it('reconciles a known remote ID through its exact range without an invented cursor',async()=>{
 const brokerMessageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async input=>{
  const query=new URL(String(input)).searchParams;
  return Response.json({payload:query.get('after')==='41'&&query.get('before')==='42'
   ?[{...message,content_attributes:{jrc_broker_message_id:brokerMessageId}}]:[]});
 }});
 await expect(client.findBrokerMessage(7,51,brokerMessageId,41)).resolves.toBe(41);
});
it('reads an exact message through the documented bounded list endpoint',async()=>{
 const fetch=vi.fn(async()=>Response.json({payload:[message]}));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 expect(typeof client.canonicalMessage).toBe('function');
 expect(await client.canonicalMessage(7,9,51,41)).toMatchObject({...message,message_type:'incoming'});
 expect(fetch.mock.calls[0]?.[0]).toBe('https://central.example.test/api/v1/accounts/7/conversations/51/messages?after=41&before=42');
});
it.each(['inbox','account','conversation','duplicate','missing'])('rejects %s instead of using the newest message',async reason=>{
 const altered={...message,...(reason==='inbox'?{inbox_id:10}:reason==='account'?{account_id:8}:reason==='conversation'?{conversation_id:52}:{})};
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json({payload:reason==='missing'?[]:reason==='duplicate'?[altered,altered]:[altered]})});
 expect(typeof client.canonicalMessage).toBe('function');
 await expect(client.canonicalMessage(7,9,51,41)).rejects.toThrow();
});
it('accepts the stock list DTO without account_id, preserving scoped URL and exact inbox/conversation',async()=>{
 const {account_id:_account,...stock}=message;
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json({payload:[stock]})});
 expect(await client.canonicalMessage(7,9,51,41)).toMatchObject({id:41,conversation_id:51,inbox_id:9});
});
it('normalizes decimal int8 IDs before proving canonical message and sender identity',async()=>{
 const dto={...message,id:'41',conversation_id:'51',account_id:'7',inbox_id:'9',sender:{id:'42',type:'User'}};
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json({payload:[dto]})});
 expect(await client.canonicalMessage(7,9,51,41)).toMatchObject({id:41,conversation_id:51,account_id:7,inbox_id:9,sender:{id:42,type:'User'}});
});
it.each(['041','1e2','9007199254740992','0','-1'])('rejects noncanonical or unsafe int8 identity %s',async id=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json({payload:[{...message,id}]})});
 await expect(client.canonicalMessage(7,9,51,41)).rejects.toThrow();
});
it('pins the central sender to the authenticated administrator of the requested account',async()=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json({id:12,accounts:[{id:7,role:'administrator'}]})});
 expect(await client.centralSender(7)).toBe(12);
 await expect(client.centralSender(8)).rejects.toThrow('CHATWOOT_ACCOUNT_ACCESS_REQUIRED');
});
it.each([{accounts:[{id:7,role:'administrator'}]},{id:12,accounts:[{id:7,role:'agent'}]}])('refuses unproven central sender %j',async profile=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json(profile)});
 await expect(client.centralSender(7)).rejects.toThrow();
});
