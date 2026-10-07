import { expect,it,vi } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';
const message={id:41,conversation_id:51,account_id:7,inbox_id:9,message_type:0,private:false,content:'Synthetic input',content_type:'text',sender:{id:31,type:'contact'},created_at:100};
it('reads an exact message through the documented bounded list endpoint',async()=>{
 const fetch=vi.fn(async()=>Response.json({payload:[message]}));
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch});
 expect(typeof client.canonicalMessage).toBe('function');
 expect(await client.canonicalMessage(7,9,51,41)).toMatchObject({...message,message_type:'incoming'});
 expect(fetch.mock.calls[0]?.[0]).toBe('https://central.example.test/api/v1/accounts/7/conversations/51/messages?before=42');
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
it('pins the central sender to the authenticated administrator of the requested account',async()=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json({id:12,accounts:[{id:7,role:'administrator'}]})});
 expect(await client.centralSender(7)).toBe(12);
 await expect(client.centralSender(8)).rejects.toThrow('CHATWOOT_ACCOUNT_ACCESS_REQUIRED');
});
it.each([{accounts:[{id:7,role:'administrator'}]},{id:12,accounts:[{id:7,role:'agent'}]}])('refuses unproven central sender %j',async profile=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>Response.json(profile)});
 await expect(client.centralSender(7)).rejects.toThrow();
});
