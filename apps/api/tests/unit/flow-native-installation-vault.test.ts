import {expect,it} from 'vitest';import {randomUUID} from 'node:crypto';import {createInstallationVault} from '../../src/modules/flows/delegation/installation/vault.js';
it('separates installation callback and response ciphers by tenant, operation, generation and purpose',()=>{
 const vault=createInstallationVault(JSON.stringify({1:Buffer.alloc(32,11).toString('base64')})),context={organizationId:randomUUID(),id:randomUUID(),generation:1,purpose:'FLOW_INSTALLATION_CALLBACK' as const},token='k'.repeat(43),sealed=vault.seal(context,token);
 expect(sealed.encrypted).not.toContain(token);expect(vault.open(context,sealed)).toBe(token);
 for(const changed of [{...context,organizationId:randomUUID()},{...context,id:randomUUID()},{...context,generation:2},{...context,purpose:'FLOW_INSTALLATION_RESPONSE' as const}])expect(()=>vault.open(changed,sealed)).toThrow();
 const response=vault.seal({...context,purpose:'FLOW_INSTALLATION_RESPONSE'},JSON.stringify({token}));expect(vault.open({...context,purpose:'FLOW_INSTALLATION_RESPONSE'},response)).toBe(JSON.stringify({token}));
 expect(()=>vault.open({...context,purpose:'FLOW_INSTALLATION_RESPONSE'},sealed)).toThrow();
});
