import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {InstallationClaimSchema,InstallationRenewSchema,InstallationProofSchema,installationTupleDigest} from '../../src/modules/flows/delegation/installation/contracts.js';
it('keeps installation operations audience-specific and rejects caller organization/actor/origin fields',()=>{
 const claim={transferNonce:'a'.repeat(43),operationNonce:randomUUID(),installationCallbackCredential:'b'.repeat(43)};
 expect(InstallationClaimSchema.parse(claim)).toEqual(claim);
 for(const addition of [{organizationId:randomUUID()},{externalActorId:'other'},{origin:'https://foreign.test'},{nonce:randomUUID()}])expect(()=>InstallationClaimSchema.parse({...claim,...addition})).toThrow();
 expect(()=>InstallationClaimSchema.parse({...claim,transferNonce:'a.jwt.token'})).toThrow();
 const renewal={operationNonce:randomUUID(),expectedGeneration:2,expectedCredentialId:randomUUID(),expectedCredentialRevision:1,nativeCallbackCredential:'c'.repeat(43)};
 expect(InstallationRenewSchema.parse(renewal)).toEqual(renewal);
 expect(()=>InstallationRenewSchema.parse({...renewal,integrationIds:[randomUUID()]})).toThrow();
});
it('hashes an immutable canonical target set and detects mapping/revision changes',()=>{
 const target={integrationId:randomUUID(),channelId:randomUUID(),inboxId:9,transport:'CENTRAL_TRANSPORT',provider:null};
 const tuple={accountId:7,destinationRevision:2,accountCredentialVersion:3,targets:[target]};
 const digest=installationTupleDigest(tuple);
 expect(digest).toMatch(/^[a-f0-9]{64}$/);
 expect(installationTupleDigest({...tuple,targets:[{provider:null,transport:'CENTRAL_TRANSPORT',inboxId:9,channelId:target.channelId,integrationId:target.integrationId}]})).toBe(digest);
 expect(installationTupleDigest({...tuple,destinationRevision:3})).not.toBe(digest);
 expect(()=>installationTupleDigest({...tuple,targets:[target,target]})).toThrow();
 const brokerTarget={...target,integrationId:randomUUID(),inboxId:10,transport:'BROKER_TRANSPORT',provider:'BAILEYS'};
 expect(installationTupleDigest({...tuple,targets:[target,brokerTarget]})).toBe(installationTupleDigest({...tuple,targets:[brokerTarget,target]}));
});
it('rejects native introspection or registration proof as installation authority',()=>{
 expect(()=>InstallationProofSchema.parse({nonce:randomUUID(),accountId:7,externalActorId:'21',destinationRevision:2,inboxIds:[9]})).toThrow();
 const proof={audience:'FLOW_INSTALLATION_RENEW',grantId:randomUUID(),operationNonce:randomUUID(),proofNonce:randomUUID(),expectedGeneration:2,
  registrationId:randomUUID(),registrationRevision:1,credentialId:randomUUID(),credentialRevision:1,destinationRevision:2,accountCredentialVersion:3,accountId:7,tupleDigest:'a'.repeat(64)};
 expect(InstallationProofSchema.parse(proof)).toEqual(proof);
 expect(()=>InstallationProofSchema.parse({...proof,audience:'FLOW_NATIVE_CALLBACK'})).toThrow();
});
