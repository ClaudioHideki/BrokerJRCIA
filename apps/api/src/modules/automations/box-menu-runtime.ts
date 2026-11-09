import {DirectoryMenuSchema,BoxDirectorySnapshotSchema,type FlowNode} from '@jrc/contracts';
import type {RuntimeState} from './types.js';
import {runtimeJson,renderRuntimeText} from './runtime-state.js';

export function directoryMenu(node:FlowNode,state:RuntimeState){
 const config=DirectoryMenuSchema.parse(node.data);
 if(!state.boxDirectory)throw Error('FLOW_BOX_PROFILE_REQUIRED');
 const directory=BoxDirectorySnapshotSchema.parse(runtimeJson(state.boxDirectory));
 const route=directory.routes.find(r=>r.routeKey===config.routeKey);
 if(!route||route.mode!=='AGENT')throw Error('FLOW_BOX_ROUTE_UNAVAILABLE');
 const backValue=route.backValue??String(route.agents.length+1);
 const text=[renderRuntimeText(config.text,state.variables),...route.agents.map((a,i)=>`${a.optionValue??i+1} - ${a.name}`),`${backValue} - ${renderRuntimeText(config.backLabel,state.variables)}`].join('\n');
 const errorText=renderRuntimeText(config.errorMessage,state.variables);
 if(text.length>4096||errorText.length+text.length+1>4096)throw Error('FLOW_BOX_MENU_TEXT_LIMIT');
 return {config,route,text,errorText,backValue};
}
