import {expect,it,vi} from 'vitest';
import {createMetaOnboardingWebhook} from '../../src/modules/meta-onboarding/webhook.js';

const fields=['account_update','account_review_update','phone_number_name_update','phone_number_quality_update','business_capability_update','message_template_status_update','message_template_quality_update'];
it.each(fields)('routes signed %s only to the server-resolved WABA owner',async field=>{
 const managementUpdated=vi.fn(async()=>{});const ingestMessages=vi.fn(async()=>{});
 const ingest=createMetaOnboardingWebhook({managementUpdated,refreshConnection:vi.fn(),ingestMessages,findWaba:vi.fn(async()=>[{organizationId:'owner',id:'connection'}])});
 await ingest({object:'whatsapp_business_account',entry:[{id:'12345',time:123,changes:[{field,value:{organization_id:'attacker',secret:'must-not-persist'}}]}]});
 expect(managementUpdated).toHaveBeenCalledTimes(1);
 expect(managementUpdated).toHaveBeenCalledWith('owner','connection',field,expect.stringMatching(/^[a-f0-9]{64}$/));
 expect(ingestMessages).not.toHaveBeenCalled();
});
it('deduplicates identical signals in one envelope and ignores unknown fields and unbound WABAs',async()=>{
 const managementUpdated=vi.fn(async()=>{});const ingestMessages=vi.fn(async()=>{});
 const ingest=createMetaOnboardingWebhook({managementUpdated,refreshConnection:vi.fn(),ingestMessages,findWaba:async id=>id==='12345'?[{organizationId:'owner',id:'connection'}]:[]});
 const change={field:'phone_number_quality_update',value:{event:'FLAGGED'}};
 await ingest({object:'whatsapp_business_account',entry:[{id:'12345',time:123,changes:[change,change,{field:'unknown',value:{}}]},{id:'99999',changes:[change]}]});
 expect(managementUpdated).toHaveBeenCalledTimes(1);
});
it('records every affected connection before Graph rechecks and refreshes each connection at most once',async()=>{
 const order:string[]=[];
 const managementUpdated=vi.fn(async(_org:string,id:string)=>{order.push('invalidate:'+id);return true;});
 const refreshConnection=vi.fn(async(_org:string,id:string)=>{order.push('refresh:'+id);});
 const ingest=createMetaOnboardingWebhook({managementUpdated,refreshConnection,ingestMessages:vi.fn(),findWaba:async()=>[{organizationId:'a',id:'one'},{organizationId:'a',id:'two'}]});
 await ingest({object:'whatsapp_business_account',entry:[{id:'12345',changes:[{field:'account_update',value:{}},{field:'phone_number_quality_update',value:{}}]}]});
 expect(order.slice(0,4).every(value=>value.startsWith('invalidate:'))).toBe(true);
 expect(refreshConnection).toHaveBeenCalledTimes(2);
});
