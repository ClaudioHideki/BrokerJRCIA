import {z} from 'zod';
import {AiNodeConfigSchema,AiCredentialPolicySchema,AiCredentialCatalogPageSchema,maximumAiCost,type AiNodeConfig} from '@jrc/contracts';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {SubflowSnapshot} from './subflow-dependencies.js';
import {AutomationError} from './errors.js';
export interface AiCredentialMetadata{id:string;organizationId:string;type:string;status:string;revision:number;metadata:Record<string,unknown>}
export function assertAiCredentialPolicy(org:string,config:AiNodeConfig,current:AiCredentialMetadata|null){
 if(!current||current.organizationId!==org||current.id!==config.credentialId||current.type!=='AI_PROVIDER'||current.status!=='ACTIVE')throw new AutomationError('AUTOMATION_AI_CREDENTIAL_UNAVAILABLE',409);
 if(current.revision!==config.credentialRevision)throw new AutomationError('AUTOMATION_AI_CREDENTIAL_CHANGED',409);
 const parsed=AiCredentialPolicySchema.safeParse(current.metadata.aiPolicy);if(!parsed.success)throw new AutomationError('AUTOMATION_AI_POLICY_REQUIRED',409);
 const model=parsed.data.models.find(item=>item.name===config.model);if(!model)throw new AutomationError('AUTOMATION_AI_MODEL_NOT_APPROVED',409);
 const maximum=maximumAiCost(config,model);if(maximum>config.maxCostMicros||maximum>parsed.data.monthlyCostMicros)throw new AutomationError('AUTOMATION_AI_COST_LIMIT',409);
 return {policy:parsed.data,model};
}
export async function assertAiPolicies(tx:TenantTransaction,org:string,snapshot:Pick<SubflowSnapshot,'root'|'resolve'>){
 const visited=new Set<string>();const visit=async(current:typeof snapshot.root,caller?:string):Promise<void>=>{
  const key=current.automationId+':'+current.version;if(visited.has(key))return;visited.add(key);
  for(const node of current.graph.nodes){
   if(node.type.startsWith('ai-')&&node.data.aiConfigVersion!==undefined)try{
    const config=AiNodeConfigSchema.parse(node.data);if('ai-'+config.operation!==node.type)throw Error('invalid');
    const row=(await tx.query<AiCredentialMetadata>(`select id,organization_id as "organizationId",type,status,revision,jsonb_build_object('aiPolicy',metadata->'aiPolicy') as metadata from automation_credentials where organization_id=$1 and id=$2 for share`,[org,config.credentialId])).rows[0]??null;
    assertAiCredentialPolicy(org,config,row);
   }catch(error){const code=error instanceof AutomationError?error.code:'AUTOMATION_AI_CONFIG_INVALID';throw new AutomationError(code,409,[{nodeId:caller??node.id,field:'data.credentialId',code,message:'IA indisponível. Atualize a credencial e o modelo por nome; confira os preços estimados e o orçamento em Credenciais.'}]);}
   if(node.type==='subflow')await visit(await snapshot.resolve(String(node.data.automationId),Number(node.data.version)),caller??node.id);
  }
 };await visit(snapshot.root);
}
const cursorSchema=z.strictObject({organizationId:z.uuid(),rootAutomationId:z.uuid(),id:z.uuid()});
export async function readAiCredentialCatalog(tx:TenantTransaction,org:string,root:string,input:{pageSize?:number;cursor?:string}={}){
 const pageSize=input.pageSize??200;if(!Number.isInteger(pageSize)||pageSize<1||pageSize>200)throw new AutomationError('AUTOMATION_AI_PAGE_SIZE_INVALID',400);
 let after:string|null=null;if(input.cursor)try{if(!/^[A-Za-z0-9_-]{1,256}$/u.test(input.cursor))throw Error('invalid');const c=cursorSchema.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));if(c.organizationId!==org||c.rootAutomationId!==root)throw Error('scope');after=c.id;}catch{throw new AutomationError('AUTOMATION_AI_CURSOR_INVALID',400);}
 const rows=(await tx.query<{id:string;name:string;revision:number;metadata:Record<string,unknown>}>(`select id,name,revision,jsonb_build_object('aiPolicy',metadata->'aiPolicy') as metadata from automation_credentials where organization_id=$1 and status='ACTIVE' and type='AI_PROVIDER' and ($2::uuid is null or id>$2::uuid) order by id limit $3`,[org,after,pageSize+1])).rows;
 const data=rows.slice(0,pageSize).map(row=>{const policy=AiCredentialPolicySchema.safeParse(row.metadata.aiPolicy);return {id:row.id,name:row.name,revision:row.revision,models:policy.success?policy.data.models:[],monthlyCostMicros:policy.success?policy.data.monthlyCostMicros:0};});
 const last=data.at(-1),nextCursor=rows.length>pageSize&&last?Buffer.from(JSON.stringify({organizationId:org,rootAutomationId:root,id:last.id})).toString('base64url'):null;
 const page=AiCredentialCatalogPageSchema.safeParse({schemaVersion:1,scope:{organizationId:org,rootAutomationId:root},data,nextCursor});if(!page.success||rows.length>pageSize+1||new Set(data.map(row=>row.id)).size!==data.length)throw new AutomationError('AUTOMATION_AI_CATALOG_INVALID',503);return page.data;
}
