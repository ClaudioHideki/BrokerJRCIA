import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {TenantTransaction} from '../../src/db/tenant-transaction.js';
import {promoteAttendanceInput} from '../../src/modules/attendance/event-router.js';
import * as authority from '../../src/modules/attendance/runtime-authority.js';

afterEach(()=>vi.restoreAllMocks());
describe('capture admission authority',()=>{
  it('preserves the repository group policy when checking the marked wait',async()=>{
    const org=randomUUID(),id=randomUUID(),waitId=randomUUID(),policy={encryptionKey:Buffer.alloc(32).toString('base64'),configurationScope:'synthetic-group'};
    vi.spyOn(authority,'runtimeAuthorityAllows').mockImplementation(async(_tx,_input,_remote,configured)=>configured===policy);
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('from automation_waits w')?[{id:waitId,nodeId:'capture',deadline:null,expired:false,state:{waiting:{kind:'EVENT',nodeId:'capture',waitId}},channelId:randomUUID(),conversationId:randomUUID(),automationId:randomUUID(),version:1}]:sql.includes('select id,event_key,payload')?[{id:randomUUID(),event_key:'answer',payload:{text:'Maria'},admittedAt:new Date(1000)}]:[],rowCount:1}));
    await expect(promoteAttendanceInput({query} as unknown as TenantTransaction,org,id,policy)).resolves.toBe(true);
  });
});
