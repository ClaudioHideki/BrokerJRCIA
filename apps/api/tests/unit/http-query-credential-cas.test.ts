import {describe,it,expect,vi} from 'vitest';
import {createCredentialService,type CredentialRepository,type CredentialRow,type CredentialVault} from '../../src/modules/automation-integrations/credentials.js';
import type {TenantTransaction,OrganizationTransaction} from '../../src/db/tenant-transaction.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
function fixture(){
 let row:CredentialRow={id,organizationId:org,name:'ERP',type:'BEARER',encryptedSecret:'preserve-ciphertext',fingerprint:'a'.repeat(64),keyVersion:1,metadata:{keep:'value'},status:'ACTIVE',revision:3,lastTestedAt:null,createdAt:new Date(),updatedAt:new Date()};
 const repository={get:vi.fn().mockImplementation(async()=>row),policy:vi.fn().mockImplementation(async(_tx,input)=>{if(input.revision!==row.revision)return null;row={...row,revision:row.revision+1,metadata:{...row.metadata,allowedOrigins:input.allowedOrigins}};return row;})} as unknown as CredentialRepository;
 const vault={seal:vi.fn(),open:vi.fn().mockReturnValue({token:'hidden'})} as unknown as CredentialVault;
 const tx={} as TenantTransaction,service=createCredentialService({transact:<T>(_org:string,work:OrganizationTransaction<T>)=>work(tx),repository,vault});return{service,repository,vault,current:()=>row};
}
describe('HTTP destination policy CAS without secret rotation',()=>{
 it('preserves secret material and unrelated metadata while invalidating stale selected revisions',async()=>{
  const {service,repository,vault,current}=fixture();const result=await service.updateHttpPolicy(org,id,{revision:3,allowedOrigins:['https://api.example.test']});
  expect(repository.get).toHaveBeenCalledWith(expect.anything(),org,id,true);expect(result.revision).toBe(4);expect(current()).toMatchObject({encryptedSecret:'preserve-ciphertext',fingerprint:'a'.repeat(64),metadata:{keep:'value',allowedOrigins:['https://api.example.test']}});expect(vault.seal).not.toHaveBeenCalled();expect(vault.open).not.toHaveBeenCalled();
  await expect(service.updateHttpPolicy(org,id,{revision:3,allowedOrigins:['https://other.test']})).rejects.toThrow('CREDENTIAL_CHANGED');
 });
 it('rejects unsafe origins before metadata mutation and resolves the current revision for runtime checks',async()=>{
  const {service,repository}=fixture();await expect(service.updateHttpPolicy(org,id,{revision:3,allowedOrigins:['http://localhost']})).rejects.toThrow();expect((repository as unknown as {policy:ReturnType<typeof vi.fn>}).policy).not.toHaveBeenCalled();expect((await service.resolve(org,id)).revision).toBe(3);
 });
});
