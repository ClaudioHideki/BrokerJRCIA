import {expect,it} from 'vitest';
import {ChannelOperationProfileSchema} from '../src/index.js';
const id='11111111-1111-4111-8111-111111111111';
const profile={schemaVersion:1,organizationId:id,channelId:id,messagingChannelId:id,observedAt:'2026-10-06T12:00:00Z',mode:'STANDALONE',transport:'BROKER_TRANSPORT',readiness:'READY',blockers:[],central:null,deliveryVerified:false,capabilitiesObservedAt:null,callbackObservedAt:null};
it('rejects fabricated operational delivery and extra credential fields',()=>{
 expect(ChannelOperationProfileSchema.safeParse({...profile,deliveryVerified:true}).success).toBe(false);
 expect(ChannelOperationProfileSchema.safeParse({...profile,token:'secret'}).success).toBe(false);
 expect(ChannelOperationProfileSchema.parse(profile)).toEqual(profile);
});
it('rejects internally contradictory observations',()=>{
 expect(ChannelOperationProfileSchema.safeParse({...profile,readiness:'READY',blockers:['ACCOUNT_NOT_READY']}).success).toBe(false);
 expect(ChannelOperationProfileSchema.safeParse({...profile,mode:null}).success).toBe(false);
 expect(ChannelOperationProfileSchema.safeParse({...profile,messagingChannelId:null}).success).toBe(false);
 expect(ChannelOperationProfileSchema.safeParse({...profile,transport:'CENTRAL_TRANSPORT'}).success).toBe(false);
 expect(ChannelOperationProfileSchema.safeParse({...profile,mode:'CHATWOOT_EXTERNAL'}).success).toBe(false);
});
