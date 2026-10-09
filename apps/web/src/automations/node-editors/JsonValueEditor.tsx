import {useEffect,useId,useState} from 'react';
type Kind='string'|'number'|'boolean'|'null'|'object'|'array';
type Props={value:unknown;onChange:(value:unknown)=>void;editable:boolean;label?:string;depth?:number};
const kindOf=(value:unknown):Kind=>value===null?'null':Array.isArray(value)?'array':typeof value==='object'?'object':typeof value==='number'?'number':typeof value==='boolean'?'boolean':'string';
const initial:Record<Kind,unknown>={string:'',number:0,boolean:false,null:null,object:{},array:[]};
const labels:Record<Kind,string>={string:'Texto',number:'Número',boolean:'Sim ou não',null:'Nulo',object:'Objeto',array:'Lista'};
/** Structured editing never evaluates text or reparses an entire imported value. */
export function JsonValueEditor({value,onChange,editable,label='valor',depth=0}:Props){
 const [kind,setKind]=useState<Kind>(()=>kindOf(value));
 const [numeric,setNumeric]=useState(()=>typeof value==='number'?String(value):'');
 const [keys,setKeys]=useState<Record<string,string>>({});
 const [keyError,setKeyError]=useState<string|null>(null);
 const id=useId();
 useEffect(()=>{if(value!==undefined){setKind(kindOf(value));if(typeof value==='number')setNumeric(String(value));}},[value]);
 const emit=(next:unknown)=>{if(editable)onChange(next);};
 const object=kind==='object'&&value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
 const array=kind==='array'&&Array.isArray(value)?value:[];
 const children=kind==='object'?Object.keys(object).length:array.length;
 return <div className="automation-json-value">
  <label>{label==='valor'?'Tipo do valor':'Tipo do '+label}<select disabled={!editable} value={kind} onChange={event=>{
   const next=event.target.value as Kind;setKind(next);setKeys({});setKeyError(null);setNumeric(next==='number'?'0':'');emit(initial[next]);
  }}>{(Object.keys(labels) as Kind[]).map(item=><option key={item} value={item}>{labels[item]}</option>)}</select></label>
  {kind==='string'&&<label>{label==='valor'?'Valor':'Valor do '+label}<input disabled={!editable} value={typeof value==='string'?value:''} onChange={event=>emit(event.target.value)}/></label>}
  {kind==='number'&&<label>{label==='valor'?'Valor':'Valor do '+label}<input disabled={!editable} inputMode="decimal" value={numeric} aria-invalid={value===undefined} onChange={event=>{
   setNumeric(event.target.value);const text=event.target.value.trim();emit(text&&Number.isFinite(Number(text))?Number(text):undefined);
  }}/></label>}
  {kind==='boolean'&&<label>{label==='valor'?'Valor':'Valor do '+label}<select disabled={!editable} value={String(value===true)} onChange={event=>emit(event.target.value==='true')}><option value="true">Sim</option><option value="false">Não</option></select></label>}
  {kind==='null'&&<p>Valor nulo.</p>}
  {(kind==='array'||kind==='object')&&(depth>=8||children>64)?<p role="note">Valor preservado. Este editor mostra até 64 campos por nível e 8 níveis; escolha outro tipo para substituí-lo.</p>:<>
   {kind==='object'&&Object.entries(object).map(([name,item])=><fieldset key={name} disabled={!editable}>
    <label>Nome do campo {name}<input value={keys[name]??name} aria-invalid={keyError===name} aria-describedby={keyError===name?id:undefined} onChange={event=>setKeys({...keys,[name]:event.target.value})} onBlur={()=>{
     const next=keys[name]??name;
     if(next===name)return;
     if(!next.trim()||['__proto__','prototype','constructor'].includes(next)||Object.hasOwn(object,next)){setKeyError(name);return;}
     const renamed=Object.fromEntries(Object.entries(object).map(([field,stored])=>[field===name?next:field,stored]));setKeys({});setKeyError(null);emit(renamed);
    }}/></label>
    <JsonValueEditor value={item} label={'campo '+name} depth={depth+1} editable={editable} onChange={next=>emit(Object.fromEntries(Object.entries(object).map(([field,stored])=>[field,field===name?next:stored])))}/>
    <button type="button" disabled={!editable} onClick={()=>emit(Object.fromEntries(Object.entries(object).filter(([field])=>field!==name)))}>Remover campo {name}</button>
   </fieldset>)}
   {kind==='array'&&array.map((item,index)=><fieldset key={index} disabled={!editable}>
    <JsonValueEditor value={item} label={'item '+(index+1)} depth={depth+1} editable={editable} onChange={next=>emit(array.map((stored,at)=>at===index?next:stored))}/>
    <button type="button" disabled={!editable||index===0} onClick={()=>{const next=[...array];[next[index-1],next[index]]=[next[index],next[index-1]];emit(next);}}>Mover item {index+1} para cima</button>
    <button type="button" disabled={!editable} onClick={()=>emit(array.filter((_,at)=>at!==index))}>Remover item {index+1}</button>
   </fieldset>)}
   {kind==='object'&&<button type="button" disabled={!editable||children>=64} onClick={()=>{let name='campo';let n=1;while(Object.hasOwn(object,name))name='campo'+n++;emit({...object,[name]:''});}}>Adicionar campo</button>}
   {kind==='array'&&<button type="button" disabled={!editable||children>=64} onClick={()=>emit([...array,''])}>Adicionar item</button>}
  </>}
  {keyError&&<p id={id} role="alert">Informe um nome diferente dos outros campos e dos nomes reservados.</p>}
 </div>;
}
