import {expect,it} from 'vitest';
import {renderDomainCommandArguments} from '../../src/modules/automations/domain-command-arguments.js';
const episode='11111111-1111-4111-8111-111111111111';
const base={conversationEffectVersion:2 as const,operation:'domain' as const,channelId:episode,target:'intake.result',timeoutMs:15000};
const input={system:'example',location:'south',reason:'request',subject:'access',profile:'requester',identifier:'{{identifier}}',
 email:'{{email}}',description:'{{description}}'};
it('pins qualification, handoff and status to the persisted execution episode',()=>{
 const config={...base,command:'service_desk_intake' as const,configurationId:7,configurationRevision:2,phase:'qualified' as const,input};
 const variables={identifier:'12345678901',email:'synthetic@example.invalid',description:'Synthetic request'};
 const qualified=renderDomainCommandArguments(config,variables,episode);
 const handoff=renderDomainCommandArguments({...config,phase:'handoff'},variables,episode);
 const status=renderDomainCommandArguments({...base,command:'service_desk_status'},variables,episode);
 expect(qualified).toMatchObject({episode_key:episode,phase:'qualified',input:variables});
 expect(handoff).toMatchObject({episode_key:episode,phase:'handoff'});
 expect(status).toEqual({command:'service_desk_status',episode_key:episode});
 expect(()=>renderDomainCommandArguments(config,{},episode)).toThrow();
});
