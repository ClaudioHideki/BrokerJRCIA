import {useId} from 'react';
import type {FlowNode} from '@jrc/contracts';
import {getDataNodeV2Schema,isDataNodeType} from '@jrc/contracts';
import {DataReferencePicker} from './DataReferencePicker.js';
import {JsonValueEditor} from './JsonValueEditor.js';
type Props={node:FlowNode;nodes:readonly FlowNode[];editable:boolean;onChange:(data:Record<string,unknown>)=>void};
export function DataNodeEditor({node,nodes,editable,onChange}:Props){
 const id=useId(),config=node.data;
 if(!isDataNodeType(node.type))return null;
 const change=(field:string,value:unknown)=>{if(editable)onChange({...config,[field]:value});};
 if(config.configVersion!==2)return <><p role="note">Configuração histórica preservada. Para usar campos tipados e saídas de sucesso/erro, adicione um novo bloco e revise suas conexões.</p><label>Variável de destino<input disabled={!editable} value={String(config.target??'')} onChange={event=>change('target',event.target.value)}/></label></>;
 const parsed=getDataNodeV2Schema(node.type).safeParse(config);
 const error=(field:string)=>parsed.success?undefined:parsed.error.issues.find(issue=>issue.path[0]===field)?.message;
 const attrs=(field:string)=>({'aria-invalid':Boolean(error(field)),'aria-describedby':error(field)?id+'-'+field:undefined});
 const field=(key:string,label:string)=><div><label>{label}<input disabled={!editable} maxLength={100} value={String(config[key]??'')} {...attrs(key)} onChange={event=>change(key,event.target.value)}/></label>{error(key)&&<p role="alert" id={id+'-'+key}>{error(key)}</p>}</div>;
 const reference=(key:string,label:string)=><DataReferencePicker nodes={nodes.filter(item=>item.id!==node.id)} value={String(config[key]??'')} label={label} error={error(key)} editable={editable} onChange={value=>change(key,value)}/>;
 const source=config.valueSource&&typeof config.valueSource==='object'?config.valueSource as Record<string,unknown>:{kind:'LITERAL',value:''};
 const valueSource=()=> <><label>Origem do valor<select disabled={!editable} value={String(source.kind)} {...attrs('valueSource')} onChange={event=>change('valueSource',event.target.value==='VARIABLE'?{kind:'VARIABLE',variable:'message'}:{kind:'LITERAL',value:''})}><option value="LITERAL">Valor definido aqui</option><option value="VARIABLE">Variável do fluxo</option></select></label>
  {source.kind==='VARIABLE'?<DataReferencePicker nodes={nodes.filter(item=>item.id!==node.id)} label="Variável do valor" value={String(source.variable??'')} editable={editable} error={error('valueSource')} onChange={value=>change('valueSource',{kind:'VARIABLE',variable:value})}/>:<JsonValueEditor value={source.value} editable={editable} onChange={value=>change('valueSource',{kind:'LITERAL',value})}/>}
  {error('valueSource')&&<p id={id+'-valueSource'} role="alert">{error('valueSource')}</p>}</>;
 const list=(key:'keys'|'sources',label:string,max:number)=>{const values=Array.isArray(config[key])?config[key] as unknown[]:[];return <fieldset disabled={!editable}><legend>{label}</legend>{values.map((value,index)=><div key={index}>
  {key==='sources'?<DataReferencePicker nodes={nodes.filter(item=>item.id!==node.id)} label={'Origem '+(index+1)} value={String(value)} editable={editable} onChange={next=>change(key,values.map((stored,at)=>at===index?next:stored))}/>:<label>Campo {index+1}<input maxLength={100} value={String(value)} {...attrs(key)} onChange={event=>change(key,values.map((stored,at)=>at===index?event.target.value:stored))}/></label>}
  <button type="button" disabled={!editable} onClick={()=>change(key,values.filter((_,at)=>at!==index))}>Remover {key==='keys'?'campo':'origem'} {index+1}</button></div>)}
  <button type="button" disabled={!editable||values.length>=max} onClick={()=>change(key,[...values,''])}>Adicionar {key==='keys'?'campo selecionado':'origem'}</button>{error(key)&&<p role="alert" id={id+'-'+key}>{error(key)}</p>}</fieldset>;};
 return <div className="automation-data-editor">
  {field('target','Variável de destino')}{field('errorVariable','Variável de erro')}
  {node.type==='data-set'&&valueSource()}
  {!['data-set','data-merge'].includes(node.type)&&reference('source','Variável de origem')}
  {node.type==='data-pick'&&list('keys','Campos selecionados',64)}
  {node.type==='data-merge'&&list('sources','Objetos de origem',16)}
  {['data-map','data-filter'].includes(node.type)&&field('field','Caminho do campo')}
  {node.type==='data-filter'&&<><label>Comparação<select disabled={!editable} value={String(config.operator??'equals')} onChange={event=>change('operator',event.target.value)}><option value="equals">Igual a</option><option value="not_equals">Diferente de</option><option value="contains">Contém texto</option></select></label>{valueSource()}</>}
  {node.type==='expression'&&<label>Operação<select disabled={!editable} value={String(config.operation??'REFERENCE')} {...attrs('operation')} onChange={event=>change('operation',event.target.value)}><option value="REFERENCE">Copiar valor</option><option value="LOWER">Texto em minúsculas</option><option value="UPPER">Texto em maiúsculas</option><option value="TRIM">Remover espaços nas pontas</option><option value="LENGTH">Tamanho do texto, objeto ou lista</option></select></label>}
  <p>Sucesso grava o resultado no destino. Erro mantém o destino e grava um código na variável de erro.</p>
 </div>;
}
