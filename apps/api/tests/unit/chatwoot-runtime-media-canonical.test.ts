import {expect,it} from 'vitest';
const expected={version:1,contactId:301,attachments:[{id:401,kind:'image'},{id:402,kind:'document'}]};
const attachment=(id=401,file_type='image')=>({id,message_id:201,account_id:7,file_type,data_url:'https://private.invalid/file',filename:'private.png'});
const message={id:201,conversation_id:101,message_type:0,private:false,content:'NEVER_CAPTURE_CAPTION',content_type:'text',sender:{id:301,type:'contact'},created_at:1800000000,attachments:[attachment(),attachment(402,'file')]};
async function parse(value:unknown=message){const path='../../src/modules/integrations/chatwoot-runtime-media.js';const module=await import(path).catch(()=>null);expect(module,'canonical central media validator').not.toBeNull();return module!.canonicalCentralMedia(value,{accountId:7,conversationId:101,messageId:201,expected});}
it('revalidates the canonical IDs and strips private URL/name/caption metadata',async()=>{
 const result=await parse();expect(result).toEqual({createdAt:1800000000,attachments:[{id:401,kind:'image',fileName:'anexo-401'},{id:402,kind:'document',fileName:'anexo-402'}]});
 expect(JSON.stringify(result)).not.toMatch(/private|CAPTION|https/);
});
it.each([{private:true},{message_type:'outgoing'},{id:202},{conversation_id:102},{sender:{id:302,type:'contact'}},{sender:{id:301,type:'user'}},
 {attachments:[attachment()]},{attachments:[attachment(),attachment()]},{attachments:[attachment(),{...attachment(402,'file'),account_id:8}]},
 {attachments:[attachment(),{...attachment(402,'file'),message_id:202}]},{attachments:[attachment(),attachment(402,'location')]},{created_at:NaN}])('rejects changed, private or noncanonical response %j',async patch=>{
 await expect(parse({...message,...patch})).rejects.toThrow('CENTRAL_CANONICAL_MISMATCH');
});
