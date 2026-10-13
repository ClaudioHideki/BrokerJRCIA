import {expect,it} from 'vitest';
import * as contracts from '@jrc/contracts';
const c=contracts as unknown as Record<string,{safeParse(value:unknown):{success:boolean};parse(value:unknown):unknown}>;
const channel='33333333-3333-4333-8333-333333333333',binding='44444444-4444-4444-8444-444444444444';
const input={groupJid:'120000000000001@g.us',triggerText:'/menu',expectedOwnerRevision:1,expectedBindingId:binding,expectedBindingRevision:1,expectedIdentityRevision:1,expectedIdentityFingerprint:'a'.repeat(64)};
it('publishes discriminated destinations without a fabricated telephone or contact',()=>{
 expect(c.WhatsAppRecipientSchema).toBeDefined();
 expect(c.WhatsAppRecipientSchema?.safeParse({kind:'GROUP',groupJid:input.groupJid}).success).toBe(true);
 expect(c.WhatsAppRecipientSchema?.safeParse({kind:'GROUP',groupJid:input.groupJid,phone:'5511000000001'}).success).toBe(false);
 expect(c.WhatsAppRecipientSchema?.safeParse({kind:'INDIVIDUAL',phone:'5511000000001'}).success).toBe(true);
 expect(c.WhatsAppRecipientSchema?.safeParse({kind:'INDIVIDUAL',groupJid:input.groupJid}).success).toBe(false);
});
it('keeps activation explicit and rejects client-supplied scope, credentials and unsupported trigger',()=>{
 expect(c.ConfigureWhatsAppGroupAutomationSchema).toBeDefined();
 expect(c.ConfigureWhatsAppGroupAutomationSchema?.safeParse(input).success).toBe(true);
 for(const extra of [{organizationId:channel},{token:'private-canary'},{enabled:true},{triggerText:' '},{triggerText:'x'.repeat(65)}])expect(c.ConfigureWhatsAppGroupAutomationSchema?.safeParse({...input,...extra}).success).toBe(false);
});
it('publishes a safe operational read-view and requires actionable support rather than an enabled-only flag',()=>{
 expect(c.WhatsAppGroupAutomationViewSchema).toBeDefined();
 const value={schemaVersion:1,organizationId:channel,channelId:binding,groupJid:input.groupJid,subject:'Synthetic group',capability:'QR_TEXT',state:'SETUP_REQUIRED',nextAction:'ENABLE_GROUP_AUTOMATION',flow:null,identity:null,control:null,initiatorJid:null,attempts:[],observations:[]};
 expect(c.WhatsAppGroupAutomationViewSchema?.safeParse(value).success).toBe(true);
 expect(c.WhatsAppGroupAutomationViewSchema?.safeParse({...value,engineKey:'private-canary'}).success).toBe(false);
 expect(c.WhatsAppGroupAutomationViewSchema?.safeParse({...value,nextAction:'WAIT_FOREVER'}).success).toBe(false);
});
