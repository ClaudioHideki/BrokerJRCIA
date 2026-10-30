import {expect,it} from 'vitest';
import {IssueApiKeyRequestSchema} from '@jrc/contracts';
import {requestedPartnerScopes} from '../../src/modules/api-keys/service.js';
import {authorizeControlRequest} from '../../src/modules/integrations/chatwoot-control-auth.js';

it('issues archive authority only when explicitly requested and fences delegated issuance',()=>{
 expect(IssueApiKeyRequestSchema.safeParse({name:'Synthetic archive client',scopes:['media:archive']}).success).toBe(true);
 expect(requestedPartnerScopes(['media:archive','instances:read'])).toEqual(['media:archive']);
 expect(IssueApiKeyRequestSchema.parse({name:'Existing client',scopes:['messaging:read']}).scopes).toEqual(['messaging:read']);
});
it('does not accept archive authority through the Chatwoot control fence',()=>{
 expect(authorizeControlRequest({credential:{organizationId:'a',scopes:['media:archive'],revoked:false},binding:{organizationId:'a',active:true,destinationRevision:1},requestedOrganizationId:'a',requiredScope:'media:archive'})).toBe(false);
});
