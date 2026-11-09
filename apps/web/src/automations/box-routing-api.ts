import {BoxRoutingCatalogSchema,BoxProfileSchema,type BoxRoutingConfig} from '@jrc/contracts';
import {ApiClientError,type ApiClient} from '../api/client.js';
export async function getBoxRouting(client:ApiClient,org:string,automation:string,version:number,channel:string,teamId?:number){
 const raw=await client.request(`/v1/automations/${automation}/channels/${channel}/box-routing?version=${version}${teamId===undefined?'':`&teamId=${teamId}`}`);
 const parsed=BoxRoutingCatalogSchema.safeParse(raw);if(!parsed.success)throw new ApiClientError('Catálogo de atendimento inválido. Atualize os destinos.',502);
 const r=parsed.data,s=r.scope;
 if(s.organizationId!==org||s.automationId!==automation||s.version!==version||s.channelId!==channel||r.catalog.scope.organizationId!==org||r.catalog.scope.channelId!==channel||
  r.profile&&(r.profile.organizationId!==org||r.profile.automationId!==automation||r.profile.version!==version||r.profile.channelId!==channel))throw new ApiClientError('Os destinos não correspondem à empresa e caixa selecionadas.',409);
 return r;
}
export async function saveBoxRouting(client:ApiClient,org:string,automation:string,version:number,channel:string,expectedRevision:number,config:BoxRoutingConfig){
 const raw=await client.request(`/v1/automations/${automation}/channels/${channel}/box-routing`,{method:'PUT',body:JSON.stringify({version,expectedRevision,config})});
 const r=BoxProfileSchema.parse(raw);
 if(r.organizationId!==org||r.automationId!==automation||r.version!==version||r.channelId!==channel)throw new ApiClientError('A configuração não corresponde à caixa selecionada.',409);
 return r;
}
