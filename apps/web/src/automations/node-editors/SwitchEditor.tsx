import {useEffect,useState} from 'react';
import {SwitchNodeConfigSchema,type FlowNode} from '@jrc/contracts';
import {DataReferencePicker} from './DataReferencePicker.js';
type Item={id:string;label:string;value:unknown};
const kind=(value:unknown)=>value===null?'null':typeof value;
function ScalarValue({value,index,editable,onChange}:{value:unknown;index:number;editable:boolean;onChange:(value:unknown)=>void}){
 const [numeric,setNumeric]=useState(typeof value==='number'?String(value):'');
 useEffect(()=>{if(typeof value==='number')setNumeric(String(value));},[value]);
 const type=kind(value),selected=type==='undefined'?'number':type;
 return <><label>Tipo do caso {index}<select disabled={!editable} value={selected} onChange={event=>{
  const next=event.target.value;setNumeric(next==='number'?'0':'');onChange(next==='number'?0:next==='boolean'?false:next==='null'?null:'');
 }}><option value="string">Texto</option><option value="number">Número</option><option value="boolean">Sim ou não</option><option value="null">Nulo</option></select></label>
 {selected==='string'&&<label>Valor do caso {index}<input disabled={!editable} maxLength={4096} value={typeof value==='string'?value:''} onChange={e=>onChange(e.target.value)}/></label>}
 {selected==='number'&&<label>Valor do caso {index}<input disabled={!editable} inputMode="decimal" value={numeric} aria-invalid={value===undefined} onChange={e=>{
  setNumeric(e.target.value);onChange(e.target.value.trim()&&Number.isFinite(Number(e.target.value))?Number(e.target.value):undefined);
 }}/></label>}
 {selected==='boolean'&&<label>Valor do caso {index}<select disabled={!editable} value={String(value===true)} onChange={e=>onChange(e.target.value==='true')}><option value="false">Não</option><option value="true">Sim</option></select></label>}
 {selected==='null'&&<p>Compara com nulo explícito.</p>}
 {!['string','number','boolean','null'].includes(selected)&&<p role="alert">Escolha um tipo escalar para substituir o valor importado.</p>}</>;
}
export function SwitchEditor({node,nodes,editable,onChange}:{node:FlowNode;nodes:readonly FlowNode[];editable:boolean;onChange:(data:Record<string,unknown>)=>void}){
 if(Array.isArray(node.data.cases)&&(node.data.cases.length>20||node.data.cases.some(item=>!item||typeof item!=='object'||typeof item.id!=='string'||typeof item.label!=='string')))
  return <div><p role="alert">Casos importados inválidos foram preservados. Recrie os casos para configurar este bloco.</p><button type="button" disabled={!editable} onClick={()=>onChange({switchVersion:1,variable:'message',cases:[{id:'first',label:'Primeiro caso',value:''}]})}>Recriar casos</button></div>;
 const cases=Array.isArray(node.data.cases)?node.data.cases as Item[]:[];
 const change=(items:Item[])=>{if(editable)onChange({...node.data,switchVersion:1,cases:items});};
 const itemChange=(index:number,patch:Partial<Item>)=>change(cases.map((item,at)=>at===index?{...item,...patch}:item));
 const parsed=SwitchNodeConfigSchema.safeParse(node.data);
 return <div><DataReferencePicker label="Variável da decisão" nodes={nodes.filter(n=>n.id!==node.id)} value={String(node.data.variable??'message')} editable={editable}
  onChange={variable=>{if(editable)onChange({...node.data,switchVersion:1,variable});}}/>
  <p>Texto e número são diferentes: texto “1” não é número 1. A saída padrão recebe valores sem correspondência, objetos, listas ou variável ausente.</p>
  {cases.map((item,index)=><fieldset key={item.id??index} disabled={!editable}><legend>Caso {index+1}</legend>
   <label>Nome da saída {index+1}<input disabled={!editable} maxLength={80} value={String(item.label??'')} onChange={e=>itemChange(index,{label:e.target.value})}/></label>
   <ScalarValue value={item.value} index={index+1} editable={editable} onChange={value=>itemChange(index,{value})}/>
   <button type="button" disabled={!editable||cases.length<=1} onClick={()=>change(cases.filter((_,at)=>at!==index))}>Remover caso {index+1}</button>
  </fieldset>)}
  <button type="button" disabled={!editable||cases.length>=20} onClick={()=>{
   const id='c'+crypto.randomUUID().replaceAll('-','').slice(0,31);
   change([...cases,{id,label:'Caso '+(cases.length+1),value:''}]);
  }}>Adicionar caso</button>
  <p>As conexões de casos removidos devem ser revisadas antes de publicar. Renomear a saída preserva sua conexão.</p>
  {!parsed.success&&<div role="alert">{parsed.error.issues.map(issue=>issue.message).join(' ')}</div>}
 </div>;
}
