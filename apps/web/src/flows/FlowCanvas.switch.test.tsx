// @vitest-environment jsdom
import {useState} from 'react';
import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {AUTOMATION_NODE_CATALOG_V1,validateAutomationGraph,type FlowGraph} from '@jrc/contracts';
import {FlowCanvas} from './FlowCanvas.js';
it('creates and connects switch cases through the canvas and preserves the connection on rename',()=>{
 let latest:FlowGraph={nodes:[{id:'start',type:'start',label:'Início',position:{x:0,y:0},data:{}},{id:'end',type:'end',label:'Fim',position:{x:400,y:0},data:{}}],edges:[]};
 function Editor(){const [graph,setGraph]=useState(latest);return <FlowCanvas graph={graph} catalog={AUTOMATION_NODE_CATALOG_V1} editable onChange={next=>{latest=next;setGraph(next);}}/>;}
 render(<Editor/>);fireEvent.click(screen.getByRole('button',{name:/Decidir por vários valores/}));
 const item=latest.nodes.find(n=>n.type==='switch')!;expect(item.data).toMatchObject({switchVersion:1,variable:'message'});
 fireEvent.change(screen.getByLabelText('Destino Primeira opção'),{target:{value:'end'}});
 expect(latest.edges).toEqual([expect.objectContaining({source:item.id,port:'case-first',target:'end'})]);
 fireEvent.change(screen.getByLabelText('Nome da saída 1'),{target:{value:'Comercial'}});
 expect(screen.getByLabelText('Destino Comercial')).toHaveValue('end');
 expect(latest.edges[0]).toMatchObject({port:'case-first',target:'end'});
 fireEvent.change(screen.getByLabelText('Destino Saída padrão'),{target:{value:'end'}});
 expect(latest.edges).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'Remover caso 1'}));fireEvent.click(screen.getByRole('button',{name:'Adicionar caso'}));
 expect(latest.edges).toEqual(expect.arrayContaining([expect.objectContaining({port:'case-first',target:'end'})]));
 expect((latest.nodes.find(n=>n.type==='switch')!.data.cases as Array<{id:string}>).some(c=>c.id==='first')).toBe(false);
 expect(validateAutomationGraph(latest)).toEqual(expect.arrayContaining([expect.objectContaining({code:'INVALID_PORT'})]));
});
it('preserves an invalid imported case and displays recovery instead of crashing',()=>{
 const graph:FlowGraph={nodes:[{id:'bad',type:'switch',label:'Importado',position:{x:0,y:0},data:{switchVersion:1,variable:'message',cases:[null,{id:'valid',label:'Caso válido',value:1}]}}],edges:[]};
 render(<FlowCanvas graph={graph} catalog={AUTOMATION_NODE_CATALOG_V1} editable onChange={()=>{}}/>);
 expect(screen.getByRole('alert')).toHaveTextContent('Casos importados inválidos foram preservados');
 expect(screen.getByRole('button',{name:'Recriar casos'})).toBeEnabled();
});
