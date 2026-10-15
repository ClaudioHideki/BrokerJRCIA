import {it,expect,vi} from 'vitest';
import {createMediaStore} from '../../src/modules/messaging/media-store.js';
const encryptionKey=Buffer.alloc(32,1).toString('base64');
it('exposes an upload entry point on the existing private storage facade',()=>{const store=createMediaStore({encryptionKey,transact:vi.fn(),download:vi.fn()});expect(store.writeUpload).toBeTypeOf('function');});
it('rejects spoofed file before authorization, storage or remote upload',async()=>{const transact=vi.fn(),stage=vi.fn(),store=createMediaStore({encryptionKey,transact,download:vi.fn(),privateStore:{stage,dispatchPut:vi.fn(),runOnce:vi.fn(),read:vi.fn()}});await expect(store.writeUpload('org','channel',{rootAutomationId:'root',idempotencyKey:'key'},{bytes:new Uint8Array([1,2,3]),mimeType:'image/png',kind:'image',fileName:'a.png'})).rejects.toThrow();expect(transact).not.toHaveBeenCalled();expect(stage).not.toHaveBeenCalled();});
