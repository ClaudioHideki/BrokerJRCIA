import {scanOperationalOrganizations} from './automation-worker.js';

/** One bounded, paginated sweep at a time, independent of the message delivery loop. */
export function createCentralCatalogMaintenance(options:{
  loadPage:(after:string|null,limit:number)=>Promise<string[]>;
  refresh:(organizationId:string)=>Promise<unknown>;
  belongsToShard:(organizationId:string)=>boolean;
  signal?:AbortSignal;
  onError:()=>void;
}){
  let active:Promise<void>|undefined;
  return {
    start(){
      if(active||options.signal?.aborted)return;
      active=scanOperationalOrganizations(options.loadPage,async org=>{
        if(options.belongsToShard(org))await options.refresh(org);
      },options.signal,options.onError).catch(options.onError).finally(()=>{active=undefined;});
    },
    async finish(){await active;},
  };
}
