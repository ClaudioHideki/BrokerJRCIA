import {convertOiaToBoxTemplate} from '@jrc/contracts';
import {getAutomation} from './api.js';
import {ApiClientError,type ApiClient} from '../api/client.js';
/** Read/prepare only. The caller checks its current tenant generation before creating the new draft. */
export async function prepareBoxTemplateDraft(client:ApiClient,organizationId:string,id:string){
 const original=await getAutomation(client,id);
 if(original.organizationId!==organizationId||original.id!==id)throw new ApiClientError('A automação não corresponde à empresa selecionada.',409);
 try{return {name:`${original.name.slice(0,90)} — por caixa`,graph:convertOiaToBoxTemplate(original.draft.graph),sourceRevision:original.draft.revision};}
 catch{throw new ApiClientError('Conversão pendente: o rascunho não corresponde integralmente ao padrão OIA suportado. Revise menus, confirmações e subflows; o original foi preservado.',422);}
}
