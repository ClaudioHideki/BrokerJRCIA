import {z} from 'zod';
import {HttpQueryNodeConfigSchema,HttpCredentialPolicySchema,HttpCredentialCatalogPageSchema,type HttpQueryNodeConfig} from '@jrc/contracts';
import type {TenantTransaction} from '../../db/tenant-transaction.js';
import type {SubflowSnapshot} from './subflow-dependencies.js';
import {AutomationError} from './errors.js';

export interface HttpCredentialMetadata {id:string;organizationId:string;type:string;revision:number;status:string;allowedOrigins:unknown}
export function assertHttpCredentialPolicy(org:string,config:HttpQueryNodeConfig,current:HttpCredentialMetadata|null):string[]{
 if(!current||current.id!==config.credentialId||current.organizationId!==org||current.status!=='ACTIVE'||!['HTTP_HEADER','BEARER','BASIC'].includes(current.type))throw new AutomationError('AUTOMATION_HTTP_CREDENTIAL_UNAVAILABLE',409);
 if(current.revision!==config.credentialRevision)throw new AutomationError('AUTOMATION_HTTP_CREDENTIAL_CHANGED',409);
 const policy=HttpCredentialPolicySchema.safeParse({allowedOrigins:current.allowedOrigins});
 if(!policy.success)throw new AutomationError('AUTOMATION_HTTP_POLICY_REQUIRED',409);
 if(!policy.data.allowedOrigins.includes(new URL(config.url).origin))throw new AutomationError('AUTOMATION_HTTP_ORIGIN_NOT_ALLOWED',409);
 return policy.data.allowedOrigins;
}
export async function assertHttpQueryPolicies(tx:TenantTransaction,org:string,snapshot:Pick<SubflowSnapshot,'root'|'resolve'>):Promise<void>{
 const visited=new Set<string>();
 const visit=async(current:typeof snapshot.root,caller?:string)=>{
  const key=`${current.automationId}:${current.version}`;if(visited.has(key))return;visited.add(key);
  for(const node of current.graph.nodes){
   if(node.type==='http'&&node.data.httpConfigVersion!==undefined){
    try{
     const config=HttpQueryNodeConfigSchema.parse(node.data);
     // No vault/ciphertext/fingerprint is selected. The shared row lock serializes publication
     // against credential rotation, revocation and policy CAS in the same tenant.
     const row=(await tx.query<HttpCredentialMetadata>(`select id,organization_id as "organizationId",type,status,revision,metadata->'allowedOrigins' as "allowedOrigins" from automation_credentials where organization_id=$1 and id=$2 for share`,[org,config.credentialId])).rows[0]??null;
     assertHttpCredentialPolicy(org,config,row);
    }catch(error){
     const code=error instanceof AutomationError?error.code:'AUTOMATION_HTTP_CONFIG_INVALID';
     throw new AutomationError(code,409,[{nodeId:caller??node.id,field:'data.credentialId',code,message:'Consulta HTTPS indisponível. Atualize a credencial por nome no bloco e confira os destinos permitidos em Credenciais.'}]);
    }
   }
   if(node.type==='subflow')await visit(await snapshot.resolve(String(node.data.automationId),Number(node.data.version)),caller??node.id);
  }
 };await visit(snapshot.root);
}
const cursorSchema=z.strictObject({organizationId:z.uuid(),rootAutomationId:z.uuid(),id:z.uuid()});
export async function readHttpCredentialCatalog(tx:TenantTransaction,org:string,root:string,input:{pageSize?:number;cursor?:string}={}){
 const pageSize=input.pageSize??200;if(!Number.isInteger(pageSize)||pageSize<1||pageSize>200)throw new AutomationError('AUTOMATION_HTTP_PAGE_SIZE_INVALID',400);
 let after:string|null=null;
 if(input.cursor)try{
  if(!/^[A-Za-z0-9_-]{1,256}$/u.test(input.cursor))throw new Error('invalid');
  const value=cursorSchema.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));
  if(value.organizationId!==org||value.rootAutomationId!==root)throw new Error('scope');after=value.id;
 }catch{throw new AutomationError('AUTOMATION_HTTP_CURSOR_INVALID',400);}
 const rows=(await tx.query<HttpCredentialMetadata&{name:string}>(`select id,name,type,revision,metadata->'allowedOrigins' as "allowedOrigins" from automation_credentials where organization_id=$1 and status='ACTIVE' and type in ('HTTP_HEADER','BEARER','BASIC') and ($2::uuid is null or id>$2::uuid) order by id limit $3`,[org,after,pageSize+1])).rows;
 if(rows.length>pageSize+1)throw new AutomationError('AUTOMATION_HTTP_CATALOG_INVALID',503);
 const data=rows.slice(0,pageSize).map(row=>{const policy=HttpCredentialPolicySchema.safeParse({allowedOrigins:row.allowedOrigins});return{id:row.id,name:row.name,type:row.type,revision:row.revision,allowedOrigins:policy.success?policy.data.allowedOrigins:[]};});
 const last=data.at(-1),nextCursor=rows.length>pageSize&&last?Buffer.from(JSON.stringify({organizationId:org,rootAutomationId:root,id:last.id})).toString('base64url'):null;
 const parsed=HttpCredentialCatalogPageSchema.safeParse({schemaVersion:1,scope:{organizationId:org,rootAutomationId:root},data,nextCursor});
 if(!parsed.success||new Set(data.map(row=>row.id)).size!==data.length)throw new AutomationError('AUTOMATION_HTTP_CATALOG_INVALID',503);
 return parsed.data;
}
