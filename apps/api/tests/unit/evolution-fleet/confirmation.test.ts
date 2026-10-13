import {it,expect,vi} from 'vitest';
import {createMessagingWorker} from '../../../src/modules/messaging/worker.js';
import {createProvisioningReconciler} from '../../../src/modules/reconciliation/reconcile-provisioning.js';
it('does not persist SENT when the QR binding is revoked after the send ACK',async()=>{
 const calls:string[]=[];
 const claim:any={leaseToken:'lease',channel:{provider:'BAILEYS'},message:{id:'message',content:{type:'TEXT',text:'test'}},contact:{externalId:'15550000001'}};
 const repository:any={claimBotTurn:async()=>null,claimOutgoing:async()=>[claim],validateClaim:async()=>({eligible:true}),completeSend:vi.fn(async()=>{calls.push('confirm');})};
 const worker=createMessagingWorker({repository,transact:async(_o,work)=>work({query:vi.fn()} as any),captureQrBinding:async()=>({assert:async()=>{calls.push('guard');throw new Error('binding revoked');}}),resolveQrClient:async()=>({sendText:async()=>{calls.push('send');return{upstreamMessageId:'synthetic'};},sendTemplate:vi.fn(),listTemplates:vi.fn()}),resolveMetaClient:vi.fn(),resolveTypebotClient:vi.fn()});
 await expect(worker.runOnce('org')).rejects.toThrow('binding revoked');expect(calls).toEqual(['send','guard']);expect(repository.completeSend).not.toHaveBeenCalled();
});
it('a nominated UNKNOWN provisioning reconciliation never recreates an absent remote instance',async()=>{
 const lookup=vi.fn(async()=>({exists:false as const})),create=vi.fn();
 const repository:any={claimProvisioningOperation:async()=>({instance:{id:'i',provider:'BAILEYS',upstreamInstanceKey:'key'},operation:{id:'operation',status:'UNKNOWN',reconciliationRequired:true}}),completeOperation:vi.fn(async()=>{})};
 const reconcile=createProvisioningReconciler({repository,providers:{getAdminProvider:()=>({lookupInstance:lookup,reconcileProvisioning:create,deprovisionInstance:vi.fn()})},runInOrganizationTransaction:async(_o,work)=>work({query:vi.fn()} as any),writeAudit:vi.fn()});
 await expect(reconcile({organizationId:'org',operationId:'operation',requestId:'r',deadline:new Date(Date.now()+30000),signal:AbortSignal.timeout(30000)})).rejects.toMatchObject({code:'RECONCILIATION_FAILED'});
 expect(create).not.toHaveBeenCalled();expect(repository.completeOperation).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({status:'UNKNOWN',reconciliationRequired:true}));
});
