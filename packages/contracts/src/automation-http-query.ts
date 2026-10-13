import {z} from 'zod';
import {DataVariableKeySchema} from './automation-data-v2.js';

export const HTTP_QUERY_MAX_RESPONSE_BYTES=32768;
const byteLength=(value:string)=>new TextEncoder().encode(value).byteLength;
function target(value:string,originOnly:boolean):boolean{
 try{const url=new URL(value),host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||value.includes('{{')||value.includes('}}'))return false;
  if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host.startsWith('[')||/^\d+(?:\.\d+){3}$/u.test(host))return false;
  return !originOnly||value===url.origin;
 }catch{return false;}
}
export const HttpAllowedOriginSchema=z.string().max(2048).refine(value=>target(value,true),'Informe apenas o origin HTTPS permitido, por exemplo https://api.empresa.com.');
export const HttpCredentialPolicySchema=z.strictObject({allowedOrigins:z.array(HttpAllowedOriginSchema).min(1).max(20).refine(values=>new Set(values).size===values.length,'Os destinos devem ser únicos.')});
export const HttpQueryNodeConfigSchema=z.strictObject({
 httpConfigVersion:z.literal(1),method:z.literal('GET'),
 url:z.string().max(2048).refine(value=>target(value,false),'Use uma URL HTTPS fixa, sem credenciais, query, fragmento ou template.'),
 credentialId:z.uuid(),credentialRevision:z.number().int().positive(),
 queryParameters:z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u),z.string().max(2048)).refine(value=>Object.keys(value).length<=20,'Use até 20 parâmetros de consulta.'),
 target:DataVariableKeySchema,timeoutMs:z.number().int().min(100).max(30000),
 maxResponseBytes:z.number().int().min(1024).max(HTTP_QUERY_MAX_RESPONSE_BYTES),retryAttempts:z.number().int().min(0).max(2),
});
export type HttpQueryNodeConfig=z.infer<typeof HttpQueryNodeConfigSchema>;
export function compatibleHttpQuerySchema(legacy:z.ZodType):z.ZodType{
 return z.unknown().superRefine((value,context)=>{
  const marker=value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>).httpConfigVersion:undefined;
  const result=(marker===undefined?legacy:HttpQueryNodeConfigSchema).safeParse(value);
  if(!result.success)for(const issue of result.error.issues)context.addIssue({...issue,path:issue.path});
 });
}
const responseBase={type:z.literal('HTTP_RESPONSE'),nodeId:z.string().min(1).max(100)};
const responseBody=z.string().refine(value=>byteLength(value)<=HTTP_QUERY_MAX_RESPONSE_BYTES,'A resposta fictícia aceita até 32 KiB em UTF-8.');
export const HttpSimulationResponseSchema=z.discriminatedUnion('outcome',[
 z.strictObject({...responseBase,outcome:z.literal('success'),status:z.number().int().min(200).max(299),body:responseBody}),
 z.strictObject({...responseBase,outcome:z.literal('client_error'),status:z.number().int().min(400).max(499),body:responseBody}),
 z.strictObject({...responseBase,outcome:z.literal('server_error'),status:z.number().int().min(500).max(599),body:responseBody}),
 z.strictObject({...responseBase,outcome:z.literal('timeout')}),z.strictObject({...responseBase,outcome:z.literal('unknown')}),
]);
export type HttpSimulationResponse=z.infer<typeof HttpSimulationResponseSchema>;
export const HttpCredentialCatalogPageSchema=z.strictObject({
 schemaVersion:z.literal(1),scope:z.strictObject({organizationId:z.uuid(),rootAutomationId:z.uuid()}),
 data:z.array(z.strictObject({id:z.uuid(),name:z.string().min(1).max(120),type:z.enum(['HTTP_HEADER','BEARER','BASIC']),revision:z.number().int().positive(),allowedOrigins:z.array(HttpAllowedOriginSchema).max(20)})).max(200),
 nextCursor:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u).nullable(),
});
export type HttpCredentialCatalogPage=z.infer<typeof HttpCredentialCatalogPageSchema>;
