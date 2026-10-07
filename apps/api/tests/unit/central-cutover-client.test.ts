import { expect,it } from 'vitest';
import { ChatwootClient } from '../../src/modules/integrations/chatwoot-client.js';

it.each([200,204])('accepts HTTP %s empty acknowledgement of bot detachment and proves it by readback',async status=>{
 let bot:number|null=17;
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async(input,init)=>{
  const url=String(input);
  if(url.endsWith('/set_agent_bot')&&init?.method==='POST'){
   expect(JSON.parse(String(init.body))).toEqual({agent_bot:null});bot=null;
   return new Response(null,{status});
  }
  if(url.endsWith('/agent_bot')&&init?.method==='GET')return Response.json({agent_bot:bot});
  throw new Error('Unexpected synthetic request');
 }});
 await expect(client.setInboxFlowBot(7,9,null)).resolves.toBeUndefined();
 expect(await client.inboxFlowBot(7,9)).toBeNull();
});

it('keeps an empty create-bot response unknown because a bot identity and secret must be returned',async()=>{
 const client=new ChatwootClient({baseUrl:'https://central.example.test',token:'synthetic',fetch:async()=>new Response(null,{status:200})});
 await expect(client.createFlowBot(7,'Synthetic','https://broker.example.test/callback')).rejects.toMatchObject({uncertain:true,code:'CHATWOOT_INVALID_RESPONSE'});
});
