// @vitest-environment jsdom
import {fireEvent,render,screen,within} from '@testing-library/react';
import {useState} from 'react';
import {describe,expect,it} from 'vitest';
import {FlowCanvas} from '../../flows/FlowCanvas.js';
import {AUTOMATION_NODE_DEFINITIONS} from '@jrc/contracts';
import type {FlowGraph} from '@jrc/contracts';
const catalog=AUTOMATION_NODE_DEFINITIONS.map(({type,label,description})=>({type,label,description}));
const initial=(type:string,data:Record<string,unknown>):FlowGraph=>({nodes:[
 {id:'start',type:'start',label:'Receber',position:{x:0,y:0},data:{}},
 {id:'set',type,label:'Transformar',position:{x:200,y:0},data},
 {id:'other',type:'data-set',label:'Perfil capturado',position:{x:400,y:0},data:{configVersion:2,target:'profile.name',errorVariable:'profile.error',valueSource:{kind:'LITERAL',value:{name:'A'}}}},
 {id:'end',type:'end',label:'Fim',position:{x:600,y:0},data:{}},
 ],edges:[]});
function Editor({type='data-set',data,editable=true}:{type?:string;data:Record<string,unknown>;editable?:boolean}){
 const [graph,setGraph]=useState(()=>initial(type,data));
 return <><FlowCanvas graph={graph} editable={editable} catalog={catalog} onChange={setGraph}/><output aria-label="Configuração preservada">{JSON.stringify(graph.nodes[1]!.data)}</output></>;
}
const base={configVersion:2,target:'result',errorVariable:'failure'};
const select=()=>fireEvent.click(screen.getByRole('button',{name:'Configurar Transformar'}));
describe('P3 typed data inspector in canonical canvas',()=>{
 it('builds an object with typed values using fields, without a JSON textarea',()=>{
  render(<Editor data={{...base,valueSource:{kind:'LITERAL',value:{name:'A',active:true}}}}/>);select();
  expect(screen.getByRole('combobox',{name:'Tipo do valor'})).toHaveValue('object');
  fireEvent.change(screen.getByRole('textbox',{name:'Valor do campo name'}),{target:{value:'Ana'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Valor do campo active'}),{target:{value:'false'}});
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!)).toEqual({...base,valueSource:{kind:'LITERAL',value:{name:'Ana',active:false}}});
  expect(screen.queryByRole('textbox',{name:/json/i})).toBeNull();
 });
 it('offers references from typed outputs and keeps a dotted variable key intact',()=>{
  render(<Editor type="data-rename" data={{...base,source:'message'}}/>);select();
  const origin=screen.getByRole('combobox',{name:'Variável de origem'});
  expect(within(origin).getByRole('option',{name:'Perfil capturado — profile.name'})).toBeInTheDocument();
  fireEvent.change(origin,{target:{value:'profile.name'}});
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!).source).toBe('profile.name');
 });
 it('associates unsafe destination diagnostics with fields and displays two typed ports',()=>{
  render(<Editor data={{...base,target:'constructor.x',valueSource:{kind:'LITERAL',value:null}}}/>);select();
  expect(screen.getByRole('textbox',{name:'Variável de destino'})).toHaveAttribute('aria-invalid','true');
  expect(screen.getByRole('combobox',{name:'Destino Sucesso'})).toBeInTheDocument();
  expect(screen.getByRole('combobox',{name:'Destino Erro'})).toBeInTheDocument();
 });
 it('uses an operation selector for expressions and never asks for executable text',()=>{
  render(<Editor type="expression" data={{...base,source:'message',operation:'UPPER'}}/>);select();
  fireEvent.change(screen.getByRole('combobox',{name:'Operação'}),{target:{value:'LENGTH'}});
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!).operation).toBe('LENGTH');
  expect(screen.queryByRole('textbox',{name:/expressão|javascript|código/i})).toBeNull();
 });
 it('keeps configuration controls disabled and does not mutate a historical graph on render',()=>{
  render(<Editor editable={false} data={{...base,valueSource:{kind:'LITERAL',value:[1,false]}}}/>);select();
  expect(screen.getByRole('combobox',{name:'Tipo do valor'})).toBeDisabled();
  expect(screen.getByRole('textbox',{name:'Variável de erro'})).toBeDisabled();
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!).valueSource.value).toEqual([1,false]);
 });
 it('preserves legacy next ports and configuration when selecting and renaming the block',()=>{
  const legacy={target:'historical',value:'{{message}}'};
  render(<Editor data={legacy}/>);select();
  expect(screen.queryByRole('combobox',{name:'Tipo do valor'})).toBeNull();
  expect(screen.getByRole('combobox',{name:'Destino Continuar'})).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox',{name:'Nome do bloco'}),{target:{value:'Preservado'}});
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!)).toEqual(legacy);
 });
 it('reorders and removes typed list values without coercing zero or false',()=>{
  render(<Editor data={{...base,valueSource:{kind:'LITERAL',value:[0,false,'end']}}}/>);select();
  const up=screen.getByRole('button',{name:'Mover item 2 para cima'});up.focus();expect(up).toHaveFocus();fireEvent.click(up);
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!).valueSource.value).toEqual([false,0,'end']);
  fireEvent.click(screen.getByRole('button',{name:'Remover item 3'}));
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!).valueSource.value).toEqual([false,0]);
 });
 it('refuses duplicate object field names rather than overwriting their value',()=>{
  render(<Editor data={{...base,valueSource:{kind:'LITERAL',value:{first:'A',second:'B'}}}}/>);select();
  const name=screen.getByRole('textbox',{name:'Nome do campo first'});fireEvent.change(name,{target:{value:'second'}});fireEvent.blur(name);
  expect(name).toHaveAttribute('aria-invalid','true');
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!).valueSource.value).toEqual({first:'A',second:'B'});
 });
 it('keeps an empty numeric draft invalid rather than silently storing zero or null',()=>{
  render(<Editor data={{...base,valueSource:{kind:'LITERAL',value:3}}}/>);select();
  fireEvent.change(screen.getByRole('textbox',{name:'Valor'}),{target:{value:''}});
  expect(screen.getByRole('textbox',{name:'Valor'})).toHaveAttribute('aria-invalid','true');
  expect(JSON.parse(screen.getByLabelText('Configuração preservada').textContent!).valueSource).toEqual({kind:'LITERAL'});
  expect(screen.getByRole('combobox',{name:'Origem do valor'})).toHaveAttribute('aria-invalid','true');
 });
 it('configures a filter with a nested field and typed comparison value',()=>{
  render(<Editor type="data-filter" data={{...base,source:'message',field:'profile.active',operator:'equals',valueSource:{kind:'LITERAL',value:false}}}/>);select();
  fireEvent.change(screen.getByRole('textbox',{name:'Caminho do campo'}),{target:{value:'profile.enabled'}});
  fireEvent.change(screen.getByRole('combobox',{name:'Valor'}),{target:{value:'true'}});
  const result=JSON.parse(screen.getByLabelText('Configuração preservada').textContent!);
  expect(result).toMatchObject({field:'profile.enabled',valueSource:{kind:'LITERAL',value:true}});
 });
 it('associates an invalid custom reference with the actual text field',()=>{
  render(<Editor type="data-rename" data={{...base,source:'constructor.name'}}/>);select();
  expect(screen.getByRole('textbox',{name:'Nome do campo personalizado'})).toHaveAttribute('aria-invalid','true');
  expect(screen.getByRole('textbox',{name:'Nome do campo personalizado'})).toHaveAccessibleDescription(/variável inválido/);
 });
});
