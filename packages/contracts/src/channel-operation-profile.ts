import {z} from 'zod';
export const ChannelOperationBlockerSchema=z.enum([
 'CHANNEL_NOT_ACTIVATED','CHANNEL_INACTIVE','TRANSPORT_NOT_CONNECTED',
 'CENTRAL_SCOPE_UNVERIFIED','DESTINATION_NOT_APPROVED','ACCOUNT_NOT_READY',
 'CONNECTION_NOT_READY','CAPABILITIES_UNVERIFIED','CAPABILITIES_UNSUPPORTED','CENTRAL_INTEGRATION_DISABLED',
 'LEGACY_EXECUTOR_PRESENT','IDENTITY_UNVERIFIED','CALLBACK_UNVERIFIED',
]);
/** Configuration observation only. Mutations revalidate authority; real delivery is separate. */
export const ChannelOperationProfileSchema=z.strictObject({
 schemaVersion:z.literal(1),organizationId:z.uuid(),channelId:z.uuid(),messagingChannelId:z.uuid().nullable(),
 observedAt:z.iso.datetime(),mode:z.enum(['STANDALONE','JRC_MANAGED','CHATWOOT_EXTERNAL']).nullable(),
 transport:z.enum(['BROKER_TRANSPORT','CENTRAL_TRANSPORT']).nullable(),
 readiness:z.enum(['READY','BLOCKED','UNVERIFIED']),blockers:z.array(ChannelOperationBlockerSchema).max(16),
 central:z.strictObject({origin:z.url(),accountId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  inboxId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),integrationId:z.uuid(),
  destinationRevision:z.number().int().positive(),credentialVersion:z.number().int().positive()}).nullable(),
 deliveryVerified:z.literal(false),capabilitiesObservedAt:z.iso.datetime().nullable(),callbackObservedAt:z.iso.datetime().nullable(),
}).superRefine((v,ctx)=>{
 const invalid=(message:string)=>ctx.addIssue({code:'custom',message});
 if(v.readiness==='READY'&&(!v.mode||!v.transport||!v.messagingChannelId||v.blockers.length))invalid('Readiness contradicts scope or blockers');
 if(v.mode==='STANDALONE'&&(v.central!==null||v.transport==='CENTRAL_TRANSPORT'))invalid('Standalone cannot contain central authority');
 if((v.mode==='JRC_MANAGED'||v.mode==='CHATWOOT_EXTERNAL')&&!v.central)invalid('Central mode requires exact scope');
 if(v.readiness==='READY'&&v.central&&(!v.capabilitiesObservedAt||!v.callbackObservedAt))invalid('Ready central requires dated evidence');
 if(!v.mode&&(v.central||v.transport))invalid('Unverified mode cannot assert a transport or central scope');
});
export type ChannelOperationProfile=z.infer<typeof ChannelOperationProfileSchema>;
export type ChannelOperationBlocker=z.infer<typeof ChannelOperationBlockerSchema>;
