import { expect,it } from 'vitest';
import { ChannelV1Schema,CreateChannelV1Schema } from '../src/channels-v1.js';
const org='10000000-0000-4000-8000-000000000001',channel='10000000-0000-4000-8000-000000000002',integration='10000000-0000-4000-8000-000000000003';
const common={schemaVersion:1,id:channel,organizationId:org,identity:{displayName:'Central synthetic',maskedAddress:null},messagingChannelId:channel,
 transportStatus:'CONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'READY',revision:1,ownerRevision:0,
 createdAt:'2026-10-07T12:00:00.000Z',updatedAt:'2026-10-07T12:00:00.000Z'};
it('represents a central inbox without manufacturing a physical provider identity',()=>{
 const dto={...common,provider:'CENTRAL',providerReference:{integrationId:integration,accountId:7,inboxId:9}};
 expect(ChannelV1Schema.safeParse(dto).success).toBe(true);
 expect(ChannelV1Schema.safeParse({...dto,providerReference:{...dto.providerReference,instanceId:channel}}).success).toBe(false);
});
it('requires the observed central revisions and explicit choice about the previous bot at creation',()=>{
 const command={provider:'CENTRAL',name:'Synthetic',inboxId:9,expectedCredentialVersion:1,expectedDestinationRevision:1,
  expectedRemoteFingerprint:'a'.repeat(64),expectedBotId:17,replaceExistingBot:true};
 expect(CreateChannelV1Schema.safeParse(command).success).toBe(true);
 const {expectedRemoteFingerprint:_,...unobserved}=command;
 expect(CreateChannelV1Schema.safeParse(unobserved).success).toBe(false);
 expect(CreateChannelV1Schema.safeParse({...command,providerAccountId:channel}).success).toBe(false);
});
