import { describe,expect,it,vi } from 'vitest';
import type { TenantTransaction } from '../../src/db/tenant-transaction.js';
import { createCredentialService,createCredentialVault,type CredentialRepository,type CredentialRow } from '../../src/modules/automation-integrations/credentials.js';

const org='92776cb0-bcba-45c0-98a3-2937fefdfdaf',key=Buffer.alloc(32,7).toString('base64');
function fixture(){const rows=new Map<string,CredentialRow>();const repository:CredentialRepository={
 list:async()=>[...rows.values()],get:async(_tx,_org,id)=>rows.get(id)??null,
 insert:async(_tx,value)=>{const row={id:value.id,organizationId:value.org,name:value.name,type:value.type,encryptedSecret:value.encrypted,keyVersion:value.keyVersion,fingerprint:value.fingerprint,metadata:value.metadata,status:'ACTIVE' as const,revision:1,lastTestedAt:null,createdAt:new Date('2026-09-21T12:00:00Z'),updatedAt:new Date('2026-09-21T12:00:00Z')};rows.set(row.id,row);return row;},
 rotate:async(_tx,value)=>{const row=rows.get(value.id);if(!row||row.revision!==value.revision)return null;const next={...row,encryptedSecret:value.encrypted,keyVersion:value.keyVersion,fingerprint:value.fingerprint,revision:row.revision+1};rows.set(row.id,next);return next;},
 revoke:async(_tx,_org,id,revision)=>{const row=rows.get(id);if(!row||row.revision!==revision)return null;const next={...row,encryptedSecret:null,status:'REVOKED' as const,revision:row.revision+1};rows.set(id,next);return next;},
 tested:async(_tx,_org,id)=>{const row=rows.get(id)!;const next={...row,lastTestedAt:new Date()};rows.set(id,next);return next;},
 };const tester={test:vi.fn(async()=>undefined)},service=createCredentialService({transact:async(_org,work)=>work({} as TenantTransaction),vault:createCredentialVault(JSON.stringify({1:key})),repository,tester});return {service,rows,tester};}
describe('credential vault',()=>{
 it('returns metadata but never encrypted material or the secret',async()=>{const h=fixture(),created=await h.service.create(org,{name:'Meta',type:'BEARER',secret:{token:'canary-never-return'},metadata:{provider:'meta'}});expect(JSON.stringify(created)).not.toContain('canary');expect(JSON.stringify(created)).not.toContain('encrypted');const row=h.rows.get(created.id)!;expect(row.encryptedSecret).not.toContain('canary');await h.service.test(org,created.id);expect(h.tester.test).toHaveBeenCalledWith('BEARER',{token:'canary-never-return'},{provider:'meta'});});
 it('binds ciphertext to tenant, type and record through AAD',async()=>{const vault=createCredentialVault(JSON.stringify({1:key})),sealed=vault.seal(org,'BEARER','11111111-2222-4333-8444-555555555555',{token:'secret'}),row={organizationId:org,type:'BEARER',id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',keyVersion:1,status:'ACTIVE',encryptedSecret:sealed.encrypted} as CredentialRow;expect(()=>vault.open(row)).toThrow('INTEGRATION_SECRET_UNAVAILABLE');});
 it('deletes ciphertext on revocation',async()=>{const h=fixture(),created=await h.service.create(org,{name:'Banco',type:'POSTGRES',secret:{url:'postgres://example'},metadata:{}});await h.service.revoke(org,created.id,created.revision);expect(h.rows.get(created.id)?.encryptedSecret).toBeNull();});
});
