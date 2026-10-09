import type { RuntimeJson } from './types.js';
import { runtimeJson } from './runtime-state.js';
import {getDataNodeV2Schema,isDataNodeType} from '@jrc/contracts';
type Format = 'legacy' | 'json';
type Variables = Record<string, RuntimeJson>;
function read(variables: Variables, key: string, fallback: RuntimeJson, format: Format): unknown {
  const value = Object.hasOwn(variables, key) ? variables[key] : fallback;
  return format === 'json' ? value : parseData(typeof value === 'string' ? value : JSON.stringify(value));
}
const safePath=/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/;
const blocked=new Set(['__proto__','prototype','constructor']);
export const isSafeDataPath=(value:unknown):value is string=>typeof value==='string'&&safePath.test(value)&&!value.split('.').some(part=>blocked.has(part));
export function parseData(value:string):unknown{try{return JSON.parse(value);}catch{return value;}}
export function stringifyData(value:unknown):string{const output=typeof value==='string'?value:JSON.stringify(value);if(output===undefined)throw new Error('AUTOMATION_DATA_VALUE_INVALID');if(Buffer.byteLength(output)>65536)throw new Error('AUTOMATION_DATA_LIMIT');return output;}
function path(value:unknown,key:string):unknown{let current=value;for(const segment of key.split('.')){if(!isSafeDataPath(segment)||!current||typeof current!=='object'||!Object.hasOwn(current,segment))return undefined;current=(current as Record<string,unknown>)[segment];}return current;}
export function evaluateSafeExpression(expression:string,variables:Variables,format:Format = 'legacy'):unknown{const source=expression.trim();if(source.length>4096)throw new Error('AUTOMATION_EXPRESSION_LIMIT');const reference=(raw:string)=>{const key=raw.slice(2);if(!isSafeDataPath(key))throw new Error('AUTOMATION_EXPRESSION_INVALID');return read(variables,key,'',format);};if(/^\$\.[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/.test(source))return reference(source);const call=/^(lower|upper|trim|length)\((\$\.[a-zA-Z_][a-zA-Z0-9_.-]{0,99})\)$/.exec(source);if(call){const value=reference(call[2]!),text=typeof value==='string'?value:JSON.stringify(value);return call[1]==='lower'?text.toLowerCase():call[1]==='upper'?text.toUpperCase():call[1]==='trim'?text.trim():Array.isArray(value)||typeof value==='string'?value.length:Object.keys(value&&typeof value==='object'?value:{}).length;}try{return JSON.parse(source);}catch{throw new Error('AUTOMATION_EXPRESSION_INVALID');}}
export function executeDataNode(type:string,data:Record<string,unknown>,variables:Variables,format:Format = 'legacy'):Record<string,unknown>{
 if(Object.hasOwn(data,'configVersion'))return executeTypedDataNode(type,data,variables,format);
 const target=data.target;if(!isSafeDataPath(target))throw new Error('AUTOMATION_DATA_TARGET_INVALID');let output:unknown,remove:string|undefined;
 if(type==='data-set')output=data.value;
 else if(type==='data-rename'){const from=data.source;if(!isSafeDataPath(from))throw new Error('AUTOMATION_DATA_SOURCE_INVALID');output=read(variables,from,'',format);remove=from;}
 else if(type==='data-pick'){const source=data.source;if(!isSafeDataPath(source)||!Array.isArray(data.keys))throw new Error('AUTOMATION_DATA_CONFIG_INVALID');const value=read(variables,source,{},format);output=Object.fromEntries(data.keys.filter(isSafeDataPath).map(key=>[key,path(value,key)]).filter(([,value])=>value!==undefined));}
 else if(type==='data-merge'){if(!Array.isArray(data.sources))throw new Error('AUTOMATION_DATA_CONFIG_INVALID');output=Object.assign(Object.create(null),...data.sources.filter(isSafeDataPath).map(key=>{const value=read(variables,key,{},format);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}));}
 else if(type==='data-map'){const source=data.source;if(!isSafeDataPath(source))throw new Error('AUTOMATION_DATA_SOURCE_INVALID');const value=read(variables,source,[],format);if(!Array.isArray(value))throw new Error('AUTOMATION_DATA_ARRAY_REQUIRED');const field=typeof data.field==='string'&&isSafeDataPath(data.field)?data.field:null;output=field?value.map(item=>path(item,field)??null):value;}
 else if(type==='data-filter'){const source=data.source;if(!isSafeDataPath(source)||!isSafeDataPath(data.field))throw new Error('AUTOMATION_DATA_CONFIG_INVALID');const value=read(variables,source,[],format);if(!Array.isArray(value))throw new Error('AUTOMATION_DATA_ARRAY_REQUIRED');const expected=data.value,operator=data.operator;output=value.filter(item=>{const actual=path(item,data.field as string);return operator==='not_equals'?actual!==expected:operator==='contains'?String(actual).includes(String(expected)):actual===expected;});}
 else if(type==='json-parse'){const source=data.source;if(!isSafeDataPath(source))throw new Error('AUTOMATION_DATA_SOURCE_INVALID');const value=variables[source]??'';if(typeof value!=='string')throw new Error('AUTOMATION_JSON_STRING_REQUIRED');try{output=JSON.parse(value);}catch{throw new Error('AUTOMATION_JSON_INVALID');}}
 else if(type==='json-stringify'){const source=data.source;if(!isSafeDataPath(source))throw new Error('AUTOMATION_DATA_SOURCE_INVALID');output=JSON.stringify(read(variables,source,'',format));}
 else if(type==='expression'){if(typeof data.expression!=='string')throw new Error('AUTOMATION_EXPRESSION_INVALID');output=evaluateSafeExpression(data.expression,variables,format);}
 else throw new Error('AUTOMATION_DATA_NODE_UNSUPPORTED');const stored=format==='json'?runtimeJson(output):stringifyData(output);if(remove)delete variables[remove];variables[target]=stored;return {target,value:output};}

function executeTypedDataNode(type:string,data:Record<string,unknown>,variables:Variables,format:Format):Record<string,unknown> {
 if(format!=='json')throw new Error('AUTOMATION_DATA_RUNTIME_VERSION_MISMATCH');
 if(!isDataNodeType(type)||!getDataNodeV2Schema(type).safeParse(data).success)throw new Error('AUTOMATION_DATA_CONFIG_INVALID');
 const target=data.target as string;
 const reference=(key:string):RuntimeJson=>{
  if(!Object.hasOwn(variables,key))throw new Error('AUTOMATION_DATA_REFERENCE_MISSING');
  return runtimeJson(variables[key]);
 };
 const field=(value:unknown,key:string):RuntimeJson=>{
  const found=path(value,key);
  if(found===undefined)throw new Error('AUTOMATION_DATA_FIELD_MISSING');
  return runtimeJson(found);
 };
 const object=(value:RuntimeJson):Record<string,RuntimeJson>=>{
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('AUTOMATION_DATA_OBJECT_REQUIRED');
  return value;
 };
 const array=(value:RuntimeJson):RuntimeJson[]=>{if(!Array.isArray(value))throw new Error('AUTOMATION_DATA_ARRAY_REQUIRED');return value;};
 const valueSource=():RuntimeJson=>{
  const source=data.valueSource as {kind:'LITERAL';value:RuntimeJson}|{kind:'VARIABLE';variable:string};
  return source.kind==='LITERAL'?runtimeJson(source.value):reference(source.variable);
 };
 let output:unknown,remove:string|undefined;
 if(type==='data-set')output=valueSource();
 else if(type==='data-rename'){remove=data.source as string;output=reference(remove);}
 else if(type==='data-pick'){
  const source=object(reference(data.source as string));
  output=Object.fromEntries((data.keys as string[]).map(key=>[key,field(source,key)]));
 }else if(type==='data-merge')output=Object.assign(Object.create(null),...(data.sources as string[]).map(key=>object(reference(key))));
 else if(type==='data-map')output=array(reference(data.source as string)).map(value=>field(value,data.field as string));
 else if(type==='data-filter'){
  const expected=valueSource(),same=(a:RuntimeJson,b:RuntimeJson):boolean=>{
   if(a===b)return true;if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
   const aa=Object.keys(a),bb=Object.keys(b);return aa.length===bb.length&&aa.every(key=>Object.hasOwn(b,key)&&same((a as Record<string,RuntimeJson>)[key]!, (b as Record<string,RuntimeJson>)[key]!));
  };
  output=array(reference(data.source as string)).filter(value=>{
   const actual=field(value,data.field as string);
   if(data.operator==='contains'){
    if(typeof actual!=='string'||typeof expected!=='string')throw new Error('AUTOMATION_DATA_STRING_REQUIRED');
    return actual.includes(expected);
   }
   return data.operator==='not_equals'?!same(actual,expected):same(actual,expected);
  });
 }else if(type==='json-parse'){
  const source=reference(data.source as string);if(typeof source!=='string')throw new Error('AUTOMATION_JSON_STRING_REQUIRED');
  try{output=JSON.parse(source);}catch{throw new Error('AUTOMATION_JSON_INVALID');}
 }else if(type==='json-stringify')output=JSON.stringify(reference(data.source as string));
 else if(type==='expression'){
  const source=reference(data.source as string);
  if(data.operation==='REFERENCE')output=source;
  else if(data.operation==='LENGTH'){
   if(typeof source!=='string'&&(source===null||typeof source!=='object'))throw new Error('AUTOMATION_DATA_LENGTH_REQUIRED');
   output=typeof source==='string'||Array.isArray(source)?source.length:Object.keys(source as object).length;
  }else{
   if(typeof source!=='string')throw new Error('AUTOMATION_DATA_STRING_REQUIRED');
   output=data.operation==='LOWER'?source.toLowerCase():data.operation==='UPPER'?source.toUpperCase():source.trim();
  }
 }
 // Validate and copy before consuming a rename source or overwriting the destination.
 const stored=runtimeJson(output);if(remove)delete variables[remove];variables[target]=stored;
 return {outcome:'SUCCESS',target,value:stored};
}
