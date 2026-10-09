import {z} from 'zod';
export const DATA_NODE_TYPES=['data-set','data-rename','data-pick','data-merge','data-map','data-filter','json-parse','json-stringify','expression'] as const;
export type DataNodeType=typeof DATA_NODE_TYPES[number];
export const isDataNodeType=(type:string):type is DataNodeType=>(DATA_NODE_TYPES as readonly string[]).includes(type);
export const DATA_VALUE_BYTES=65536;
const blocked=new Set(['__proto__','prototype','constructor']);
export const DataVariableKeySchema=z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/u,'Informe uma variável válida.')
 .refine(key=>key.split('.').every(part=>part.length>0&&!blocked.has(part)),'Nome de variável inválido.');
export const DataFieldPathSchema=z.string().max(100).refine(value=>value.split('.').every(part=>
 /^[a-zA-Z_][a-zA-Z0-9_-]*$/u.test(part)&&!blocked.has(part)),'Informe um caminho de campo válido.');

/** The same bounded JSON contract is usable in the browser and the executor. */
function jsonIssue(value:unknown,parents=new Set<object>(),depth=0):string|null {
 if(depth>64)return 'O valor excede 64 níveis.';
 if(value===null||typeof value==='string'||typeof value==='boolean')return null;
 if(typeof value==='number')return Number.isFinite(value)?null:'O número deve ser finito.';
 if(!value||typeof value!=='object'||parents.has(value))return 'Informe um valor JSON válido.';
 if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))return 'Informe um objeto JSON simples.';
 if(Object.getOwnPropertySymbols(value).length)return 'Informe um valor JSON válido.';
 const descriptors=Object.getOwnPropertyDescriptors(value);parents.add(value);
 if(Array.isArray(value)){
  if(Object.getPrototypeOf(value)!==Array.prototype||Object.keys(descriptors).length!==value.length+1||Object.keys(value).length!==value.length)return 'A lista não pode conter posições ausentes.';
  for(let at=0;at<value.length;at++){
   const descriptor=descriptors[String(at)];
   if(!descriptor?.enumerable||!Object.hasOwn(descriptor,'value'))return 'Informe um valor JSON simples.';
   const issue=jsonIssue(descriptor.value,parents,depth+1);if(issue)return issue;
  }
 }else for(const descriptor of Object.values(descriptors)){
  if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))return 'Informe um valor JSON simples.';
  const issue=jsonIssue(descriptor.value,parents,depth+1);if(issue)return issue;
 }
 parents.delete(value);return null;
}
export const DataJsonSchema=z.unknown().superRefine((value,ctx)=>{
 const issue=jsonIssue(value);
 if(issue){ctx.addIssue({code:'custom',message:issue});return;}
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>DATA_VALUE_BYTES)ctx.addIssue({code:'custom',message:'O valor excede 64 KiB.'});
});
export const DataValueSourceSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('LITERAL'),value:DataJsonSchema}),
 z.strictObject({kind:z.literal('VARIABLE'),variable:DataVariableKeySchema}),
]);
const common={configVersion:z.literal(2),target:DataVariableKeySchema,errorVariable:DataVariableKeySchema};
const list=(schema:z.ZodType,min:number,max:number)=>z.array(schema).min(min).max(max).refine(items=>new Set(items).size===items.length,'Não repita a referência.');
const definitions={
 'data-set':z.strictObject({...common,valueSource:DataValueSourceSchema}),
 'data-rename':z.strictObject({...common,source:DataVariableKeySchema}).refine(data=>data.source!==data.target,{path:['source'],message:'Escolha uma origem diferente do destino.'}),
 'data-pick':z.strictObject({...common,source:DataVariableKeySchema,keys:list(DataFieldPathSchema,1,64)}),
 'data-merge':z.strictObject({...common,sources:list(DataVariableKeySchema,2,16)}),
 'data-map':z.strictObject({...common,source:DataVariableKeySchema,field:DataFieldPathSchema}),
 'data-filter':z.strictObject({...common,source:DataVariableKeySchema,field:DataFieldPathSchema,
  operator:z.enum(['equals','not_equals','contains']),valueSource:DataValueSourceSchema}),
 'json-parse':z.strictObject({...common,source:DataVariableKeySchema}),
 'json-stringify':z.strictObject({...common,source:DataVariableKeySchema}),
 'expression':z.strictObject({...common,source:DataVariableKeySchema,operation:z.enum(['REFERENCE','LOWER','UPPER','TRIM','LENGTH'])}),
};
export function getDataNodeV2Schema(type:DataNodeType):z.ZodType<Record<string,unknown>> {
 const schema:z.ZodType<Record<string,unknown>>=definitions[type];
 return schema.refine(data=>data.target!==data.errorVariable,{path:['errorVariable'],message:'Escolha uma variável de erro diferente do destino.'});
}
/** Versionless published graphs retain their historical validation. A marker never falls back. */
export function compatibleDataNodeSchema(type:DataNodeType,legacy:z.ZodType):z.ZodType {
 return z.unknown().superRefine((value,ctx)=>{
  const marked=value!==null&&typeof value==='object'&&Object.hasOwn(value,'configVersion');
  const result=(marked?getDataNodeV2Schema(type):legacy).safeParse(value);
  if(!result.success)for(const issue of result.error.issues)ctx.addIssue({code:'custom',message:issue.message,path:issue.path});
 });
}
export const dataNodePorts=(data:Record<string,unknown>)=>data.configVersion===2?['success','error']:['next'];
