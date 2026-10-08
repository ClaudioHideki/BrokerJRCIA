import {randomUUID} from 'node:crypto';
import {FlowGraphSchema,importFlow,type AutomationGraphV1,type FlowNode} from '@jrc/contracts';
import {z} from 'zod';
import type {OrganizationTransaction} from '../../db/tenant-transaction.js';
import {createIntegrationSecrets} from '../integrations/secrets.js';
import { convertLocalJrcFlow, isLocalJrcFlow } from './jrc-flow-converter.js';
import { AutomationError, requireAutomationDraftAccess } from '../automations/service.js';
import { claimIdempotency, completeIdempotencyRecord, hashIdempotencyRequest } from '../instances/idempotency.js';

export type ImportSource='JRC'|'N8N'|'TYPEBOT';
export interface ImportNodeReport{sourceId:string;sourceType:string;classification:'EXACT'|'PARTIAL'|'UNSUPPORTED';targetType:string|null;notes:string[]}
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const string=(value:unknown)=>typeof value==='string'?value:'';
const credentialNodeTypes=new Set(['http','sql','ai-generate','ai-classify','ai-extract','ai-summarize','ai-agent']);
function typebot(document:Record<string,unknown>):{name:string;graph:AutomationGraphV1;nodes:ImportNodeReport[]}{const groups=Array.isArray(document.groups)?document.groups:[],rawBlocks=groups.flatMap(group=>Array.isArray(record(group).blocks)?record(group).blocks as unknown[]:[]),nodes:FlowNode[]=[{id:'start',type:'start',label:'Início importado',position:{x:40,y:120},data:{}}],report:ImportNodeReport[]=[];let x=300;
 for(const [index,raw] of rawBlocks.entries()){const block=record(raw),sourceId=string(block.id)||`typebot-${index}`,type=string(block.type),content=record(block.content),node:FlowNode={id:sourceId.slice(0,100),type:'unsupported',label:string(content.label||content.text).slice(0,160)||type||`Bloco ${index+1}`,position:{x,y:120},data:{sourceType:type}};x+=260;let classification:ImportNodeReport['classification']='UNSUPPORTED',notes:string[]=[];
  if(['text','textBubble'].includes(type)){node.type='message';node.data={text:string(content.richText||content.text||block.text)};classification='PARTIAL';notes=['Formatação rica foi convertida para texto.'];}
  else if(['text input','textInput','input'].includes(type)){node.type='input';node.data={text:string(content.placeholder||content.label),variable:string(content.variableId)||`resposta_${index+1}`};classification='PARTIAL';notes=['Validações específicas do Typebot exigem revisão.'];}
  else if(['choice input','choiceInput','buttons'].includes(type)){const items=Array.isArray(content.items)?content.items:[],options=items.slice(0,10).map((item,i)=>({value:String(i+1),label:string(record(item).content||record(item).label)||`Opção ${i+1}`}));node.type='menu';node.data={text:string(content.label)||'Escolha uma opção',variable:string(content.variableId)||`opcao_${index+1}`,options};classification=options.length>=2?'PARTIAL':'UNSUPPORTED';notes=['Ramificações precisam ser reconectadas manualmente.'];}
  else if(['set variable','setVariable'].includes(type)){node.type='variable';node.data={variable:string(content.variableId)||`variavel_${index+1}`,value:string(content.value)};classification='PARTIAL';notes=['Expressões externas foram mantidas como texto.'];}
  report.push({sourceId,sourceType:type||'unknown',classification,targetType:classification==='UNSUPPORTED'?null:node.type,notes});nodes.push(node);
 }
 nodes.push({id:'end',type:'end',label:'Encerrar',position:{x,y:120},data:{}});const compatible=nodes.filter(node=>node.type!=='unsupported'),edges=compatible.slice(0,-1).map((node,index)=>({id:`edge-${index}`,source:node.id,target:compatible[index+1]!.id,port:node.type==='menu'?'option-1':'next'}));return {name:string(document.name).slice(0,120)||'Automação importada',graph:FlowGraphSchema.parse({nodes,edges}),nodes:report};}
export function convertAutomationArtifact(requestedSource:ImportSource|'AUTO',raw:string){
 if(Buffer.byteLength(raw)>2*1024*1024)throw new Error('AUTOMATION_IMPORT_SIZE_LIMIT');
 let document=record(JSON.parse(raw.replace(/^\uFEFF/,'')));
 // Compatibility follows the underlying artifact, including legacy JRC workflow wrappers.
 while(['jrc-flows/1','jrc-flows/2','jrc-broker-flows/1'].includes(string(document.format))&&record(document.flow).engine==='workflow'&&document.workflow)document=record(document.workflow);
 const source:ImportSource=Array.isArray(document.groups)?'TYPEBOT':Array.isArray(document.nodes)&&document.connections?'N8N':requestedSource==='AUTO'?'JRC':requestedSource;
 let converted:{name:string;graph:AutomationGraphV1;nodes:ImportNodeReport[]};const importWarnings:string[]=[];let credentialsRemoved=false;
 if(isLocalJrcFlow(document))converted=convertLocalJrcFlow(document);
 else if(source==='TYPEBOT')converted=typebot(document);
 else{
  const imported=importFlow(raw),sourceNodes=Array.isArray(document.nodes)?document.nodes:imported.graph.nodes;
  importWarnings.push(...imported.warnings.filter(warning=>warning==='Posições do canvas n8n foram ajustadas para caber no editor JRC.'));
  converted={name:imported.name,graph:imported.graph,nodes:sourceNodes.map((item,index)=>{
   const node=record(item),sourceType=string(node.type)||'jrc',target=imported.graph.nodes[index],notes:string[]=[];
   if(node.credentials){credentialsRemoved=true;notes.push('Credenciais removidas; selecione uma credencial do cofre.');}
   if(node.disabled===true)notes.push('Nó desabilitado na origem; reative somente após revisão.');
   if(source==='N8N')notes.push('Revise expressões, conexões e parâmetros convertidos.');
   return {sourceId:string(node.id)||String(index),sourceType,classification:(target?.type==='unsupported'?'UNSUPPORTED':source==='JRC'?'EXACT':'PARTIAL') as ImportNodeReport['classification'],targetType:target?.type==='unsupported'?null:target?.type??null,notes};
  })};
 }
 const conversionReviewNeeded=converted.nodes.some(node=>node.classification!=='EXACT');
 let credentialRemappingRequired=false;
 for(const node of converted.graph.nodes){
  // Opaque IDs are references, not secrets. Only this executable configuration
  // field requires a local selection; business data and subflow IDs stay intact.
  if(!credentialNodeTypes.has(node.type)||!Object.hasOwn(node.data,'credentialId'))continue;
  const data={...node.data};delete data.credentialId;node.data=data;
  credentialsRemoved=true;credentialRemappingRequired=true;
  const report=converted.nodes.find(item=>item.sourceId===node.id);
  if(report){
   if(report.classification==='EXACT')report.classification='PARTIAL';
   report.notes.push('Referência removida de data.credentialId; selecione uma credencial local desta empresa antes de publicar.');
  }
 }
 const reviewNeeded=conversionReviewNeeded||credentialRemappingRequired;
 if(conversionReviewNeeded&&converted.graph.nodes.length>=150&&!converted.graph.nodes.some(node=>node.type==='unsupported')){
  // At capacity, keep the artifact valid while retaining a mandatory review blocker.
  const last=converted.graph.nodes.at(-1)!,report=converted.nodes.at(-1);
  last.type='unsupported';last.data={sourceType:'IMPORT_REVIEW_REQUIRED'};
  if(report){report.classification='UNSUPPORTED';report.targetType=null;report.notes.push('Revisar importação antes de publicar.');}
 }
 const summary={source,total:converted.nodes.length,exact:converted.nodes.filter(node=>node.classification==='EXACT').length,partial:converted.nodes.filter(node=>node.classification==='PARTIAL').length,unsupported:converted.nodes.filter(node=>node.classification==='UNSUPPORTED').length,credentialsRemoved,autoPublished:false,manualReviewRequired:reviewNeeded};
 // Missing credential configuration already prevents publication. A remapping
 // alone must not add or replace unrelated nodes, even at the graph size limit.
 if(conversionReviewNeeded&&converted.graph.nodes.length<150){
  let id='import-review';while(converted.graph.nodes.some(node=>node.id===id))id+='-review';
  converted.graph.nodes.push({id,type:'unsupported',label:'Revisar importação antes de publicar',position:{x:40,y:360},data:{sourceType:'IMPORT_REVIEW_REQUIRED'}});
 }
 return {...converted,source,report:{schemaVersion:1,summary,nodes:converted.nodes,warnings:['O artefato foi importado como rascunho e nunca é publicado automaticamente.','Credenciais da origem não foram copiadas.',...importWarnings,...(isLocalJrcFlow(document)?['Caixas, gatilhos, horários, retomada e permissões devem ser configurados nesta empresa.']:[])]}};
}
export function createAutomationImporter(options:{transact<T>(org:string,work:OrganizationTransaction<T>):Promise<T>;keyring:string;enabled?:boolean}){const keys=z.record(z.string().regex(/^\d+$/),z.string()).parse(JSON.parse(options.keyring)) as Record<string,string>,versions=Object.keys(keys).map(Number).sort((a,b)=>a-b),keyVersion=versions.at(-1);if(!keyVersion)throw new Error('CREDENTIAL_VAULT_KEYRING_EMPTY');const vault=createIntegrationSecrets(keys[String(keyVersion)]!);
 return {
  preview:(_org:string,input:{source:ImportSource|'AUTO';content:string;formatVersion?:string})=>{const converted=convertAutomationArtifact(input.source,input.content);return {schemaVersion:1,name:converted.name,source:converted.source,graph:converted.graph,report:{...converted.report,warnings:['Prévia sem gravação. Confirme a importação para salvar o rascunho.',...converted.report.warnings.slice(1)]},createdAsDraft:false};},
  import:(org:string,input:{source:ImportSource|'AUTO';content:string;formatVersion?:string},idempotencyKey:string)=>{
   const requestHash=hashIdempotencyRequest({source:input.source,content:input.content,formatVersion:input.formatVersion??null});
   return options.transact(org,async tx=>{
    await requireAutomationDraftAccess(tx,org);
    const claim=await claimIdempotency(tx,{organizationId:org,route:'POST /v1/automation-imports',key:idempotencyKey,requestHash,expiresAt:new Date(Date.now()+7*24*60*60*1000)});
    if(claim.kind==='REPLAY'){
     const artifactId=z.uuid().safeParse(claim.record.responseMetadata.artifactId);
     if(claim.record.status!=='COMPLETED'||!artifactId.success)throw new AutomationError('AUTOMATION_IMPORT_REPLAY_UNAVAILABLE',503);
     const stored=await tx.query<{source:ImportSource;encryptedOriginal:string;keyVersion:number;report:ReturnType<typeof convertAutomationArtifact>['report'];convertedGraph:AutomationGraphV1}>(
      `select source,encrypted_original as "encryptedOriginal",key_version as "keyVersion",report,converted_graph as "convertedGraph"
         from automation_import_artifacts where organization_id=$1 and id=$2`,[org,artifactId.data]);
     const row=stored.rows[0],oldKey=row&&keys[String(row.keyVersion)];
     if(!row||!oldKey)throw new AutomationError('AUTOMATION_IMPORT_REPLAY_UNAVAILABLE',503);
     const original=createIntegrationSecrets(oldKey).decrypt(`${org}:automation-import:${artifactId.data}:key-${row.keyVersion}`,row.encryptedOriginal);
     const name=convertAutomationArtifact(row.source,original).name;
     return {schemaVersion:1,id:artifactId.data,name,source:row.source,graph:FlowGraphSchema.parse(row.convertedGraph),report:row.report,createdAsDraft:true};
    }
    const id=randomUUID(),converted=convertAutomationArtifact(input.source,input.content),encrypted=vault.encrypt(`${org}:automation-import:${id}:key-${keyVersion}`,input.content);
    await tx.query(`insert into automation_import_artifacts(organization_id,id,source,format_version,encrypted_original,key_version,report,converted_graph) values($1,$2,$3,$4,$5,$6,$7,$8)`,[org,id,converted.source,input.formatVersion??null,encrypted,keyVersion,JSON.stringify(converted.report),JSON.stringify(converted.graph)]);
    await completeIdempotencyRecord(tx,{organizationId:org,recordId:claim.recordId,status:'COMPLETED',responseMetadata:{artifactId:id}});
    return {schemaVersion:1,id,name:converted.name,source:converted.source,graph:converted.graph,report:converted.report,createdAsDraft:true};
   });
  }
 };}
export type AutomationImporter=ReturnType<typeof createAutomationImporter>;
