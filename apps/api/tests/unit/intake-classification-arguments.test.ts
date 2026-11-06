import {expect,it} from 'vitest';
import {DomainCommandArgumentsSchema,DomainCommandConfigSchema} from '@jrc/contracts';
import {renderDomainCommandArguments} from '../../src/modules/automations/domain-command-arguments.js';

const episode='11111111-1111-4111-8111-111111111111';
const input={system:'example',location:'south',reason:'bug',subject:'function',identifier:'52998224725',
 email:'synthetic@example.invalid',description:'Synthetic description',impact:'one',urgency:'blocked'};
const args={command:'service_desk_intake',configuration_id:7,configuration_revision:2,episode_key:episode,phase:'qualified',input};
it('carries separate bounded impact and urgency reports without accepting native weights',()=>{
 expect(DomainCommandArgumentsSchema.safeParse(args).success).toBe(true);
 for(const invalid of [{impact_value:2},{urgency_value:5},{classification_revision:3},{impact:'x'.repeat(1001)}])
  expect(DomainCommandArgumentsSchema.safeParse({...args,input:{...input,...invalid}}).success).toBe(false);
});
it('renders axis business codes and omits optional empty axes without inventing severity',()=>{
 const config=DomainCommandConfigSchema.parse({conversationEffectVersion:2,operation:'domain',channelId:episode,target:'receipt',
  timeoutMs:30000,command:'service_desk_intake',configurationId:7,configurationRevision:2,phase:'qualified',
  input:{...input,impact:'{{scope}}',urgency:'{{urgency}}'}});
 const result=renderDomainCommandArguments(config,{scope:'one',urgency:'blocked'},episode);
 expect(result).toMatchObject({input:{impact:'one',urgency:'blocked'}});
 expect('severity' in (result as typeof args).input).toBe(false);
 const empty=renderDomainCommandArguments(config,{scope:'',urgency:''},episode) as typeof args;
 expect(empty.input.impact).toBeUndefined();expect(empty.input.urgency).toBeUndefined();
});
