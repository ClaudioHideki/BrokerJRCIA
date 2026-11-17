import {describe,it,expect} from 'vitest';
import {AutomationHandoffConfigV1Schema} from '../src/automation-handoff-v1.js';

describe('intake attached to native handoff',()=>{
 it('accepts only explicit bounded intake configuration without changing the destination',()=>{
  const config={handoffVersion:1,destination:{integrationId:'11111111-1111-4111-8111-111111111111',destinationRevision:1,
   accountId:3,inboxId:13,credentialRevision:1},target:{teamId:2,agentId:null},intake:{configurationId:7,configurationRevision:2,
   input:{system:'{{collect.system}}',location:'south',reason:'request',subject:'access',identifier:'{{collect.identifier}}',
    email:'{{collect.email}}',description:'{{collect.description}}'}}};
  expect(AutomationHandoffConfigV1Schema.safeParse(config).success).toBe(true);
  expect(AutomationHandoffConfigV1Schema.safeParse({...config,intake:{...config.intake,configurationRevision:0}}).success).toBe(false);
  expect(AutomationHandoffConfigV1Schema.safeParse({...config,intake:{...config.intake,token:'forbidden'}}).success).toBe(false);
 });
});
