import {DomainCommandArgumentsSchema,type DomainCommandConfig} from '@jrc/contracts';
import {renderRuntimeText} from './runtime-state.js';
import type {RuntimeJson} from './types.js';

/** The persisted execution UUID owns the episode, independent of outbox retries/version publication. */
export function renderDomainCommandArguments(config:DomainCommandConfig,variables:Record<string,RuntimeJson>,episode:string){
 if(config.command==='service_desk_status')return DomainCommandArgumentsSchema.parse({command:config.command,episode_key:episode});
 if(config.command==='service_desk_intake')return DomainCommandArgumentsSchema.parse({command:config.command,
  configuration_id:config.configurationId,configuration_revision:config.configurationRevision,episode_key:episode,phase:config.phase,
  input:Object.fromEntries(Object.entries(config.input).map(([key,value])=>[key,renderRuntimeText(value,variables)]))});
 return DomainCommandArgumentsSchema.parse(config.command==='create_lead'?{command:config.command}:{command:config.command,
  owner_id:config.ownerId,title:renderRuntimeText(config.title,variables),
  due_at:config.dueAt.kind==='LITERAL'?config.dueAt.value:variables[config.dueAt.variable]});
}
