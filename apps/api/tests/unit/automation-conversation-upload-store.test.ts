import {it,expect,vi} from 'vitest';
import {createMediaStore,partnerMediaUploadRequestHash} from '../../src/modules/messaging/media-store.js';
import {createHash} from 'node:crypto';
import type {BinaryMedia} from '@jrc/providers';
const encryptionKey=Buffer.alloc(32,1).toString('base64');
it('exposes an upload entry point on the existing private storage facade',()=>{const store=createMediaStore({encryptionKey,transact:vi.fn(),download:vi.fn()});expect(store.writeUpload).toBeTypeOf('function');});
it('rejects spoofed file before authorization, storage or remote upload',async()=>{const transact=vi.fn(),stage=vi.fn(),store=createMediaStore({encryptionKey,transact,download:vi.fn(),privateStore:{stage,dispatchPut:vi.fn(),runOnce:vi.fn(),read:vi.fn()}});await expect(store.writeUpload('org','channel',{rootAutomationId:'root',idempotencyKey:'key'},{bytes:new Uint8Array([1,2,3]),mimeType:'image/png',kind:'image',fileName:'a.png'})).rejects.toThrow();expect(transact).not.toHaveBeenCalled();expect(stage).not.toHaveBeenCalled();});

const partnerFile:BinaryMedia={bytes:new TextEncoder().encode('synthetic'),mimeType:'text/plain',kind:'document',fileName:'fixture.txt'};
const partnerIdentity={uploadKind:'PARTNER' as const,apiKeyId:'11111111-1111-4111-8111-111111111111',idempotencyKey:'22222222-2222-4222-8222-222222222222',sha256:createHash('sha256').update(partnerFile.bytes).digest('hex'),requestHash:'0'.repeat(64)};
it('binds the partner upload hash to content metadata and tenant/channel/key while normalizing the file name',()=>{
 expect(partnerMediaUploadRequestHash('org','channel',partnerIdentity.apiKeyId,partnerFile)).toBe('cdb6798e767afde54dbe967473e768a076b54d013274be99815b1b971b7e9d84');
 const original=partnerMediaUploadRequestHash('org','channel',partnerIdentity.apiKeyId,partnerFile);
 for(const [org,channel,key,input] of [
  ['other','channel',partnerIdentity.apiKeyId,partnerFile],['org','other',partnerIdentity.apiKeyId,partnerFile],
  ['org','channel','33333333-3333-4333-8333-333333333333',partnerFile],
  ['org','channel',partnerIdentity.apiKeyId,{...partnerFile,fileName:'changed.txt'}],
  ['org','channel',partnerIdentity.apiKeyId,{...partnerFile,mimeType:'application/pdf'}],
  ['org','channel',partnerIdentity.apiKeyId,{...partnerFile,kind:'audio' as const}],
 ] as const)expect(partnerMediaUploadRequestHash(org,channel,key,input)).not.toBe(original);
 expect(partnerMediaUploadRequestHash('org','channel',partnerIdentity.apiKeyId,{...partnerFile,fileName:'../fixture.txt'})).toBe(partnerMediaUploadRequestHash('org','channel',partnerIdentity.apiKeyId,{...partnerFile,fileName:'_fixture.txt'}));
});
it('rejects a partner identity whose request hash does not bind the validated metadata before any persistence',async()=>{
 const transact=vi.fn(),store=createMediaStore({encryptionKey,transact,download:vi.fn()});
 await expect(store.writeUpload('org','channel',partnerIdentity,partnerFile)).rejects.toMatchObject({code:'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT'});
 expect(transact).not.toHaveBeenCalled();
});
it('rejects a partner identity whose byte hash is forged before any persistence',async()=>{
 const transact=vi.fn(),store=createMediaStore({encryptionKey,transact,download:vi.fn()});
 await expect(store.writeUpload('org','channel',{...partnerIdentity,sha256:'1'.repeat(64)},partnerFile)).rejects.toMatchObject({code:'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT'});
 expect(transact).not.toHaveBeenCalled();
});
it.each([
 ['empty',{...partnerFile,bytes:new Uint8Array()}],
 ['over global limit',{...partnerFile,bytes:new Uint8Array(16*1024*1024+1)}],
 ['over image limit',{...partnerFile,kind:'image' as const,mimeType:'image/png',bytes:new Uint8Array(5*1024*1024+1)}],
 ['MIME kind mismatch',{...partnerFile,kind:'image' as const}],
])('rejects %s before authorization or durable storage',async(_label,file)=>{
 const transact=vi.fn(),store=createMediaStore({encryptionKey,transact,download:vi.fn()});
 await expect(store.writeUpload('org','channel',partnerIdentity,file)).rejects.toThrow();expect(transact).not.toHaveBeenCalled();
});
