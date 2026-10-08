// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { AUTOMATION_NODE_CATALOG_V1, type FlowGraph } from '@jrc/contracts';
import { FlowCanvas } from './FlowCanvas.js';

it('creates business hours in the canvas and connects both human-readable branches',()=>{
  let observed:FlowGraph;
  function Editor(){
    const [graph,setGraph]=useState<FlowGraph>({nodes:[{id:'start',type:'start',label:'Início',position:{x:0,y:0},data:{}},{id:'end',type:'end',label:'Fim',position:{x:300,y:0},data:{}}],edges:[]});
    observed=graph;
    return <FlowCanvas graph={graph} onChange={setGraph} editable catalog={AUTOMATION_NODE_CATALOG_V1.filter(item=>item.availability==='AVAILABLE')}/>;
  }
  render(<Editor/>);
  fireEvent.click(screen.getByRole('button',{name:/^Horário/}));
  expect(screen.getByLabelText('Fuso horário')).toHaveValue('America/Sao_Paulo');
  fireEvent.change(screen.getByLabelText('Fuso horário'),{target:{value:'UTC'}});
  fireEvent.change(screen.getByLabelText('Destino Dentro do horário'),{target:{value:'end'}});
  fireEvent.change(screen.getByLabelText('Destino Fora do horário'),{target:{value:'end'}});
  const hours=observed!.nodes.find(node=>node.type==='schedule')!;
  expect(hours.data).toMatchObject({timezone:'UTC',weekly:[{day:1,start:'09:00',end:'18:00'}]});
  expect(observed!.edges.filter(edge=>edge.source===hours.id).map(edge=>({port:edge.port,target:edge.target}))).toEqual([{port:'open',target:'end'},{port:'closed',target:'end'}]);
  fireEvent.click(screen.getByRole('button',{name:'Desfazer'}));
  expect(observed!.edges.filter(edge=>edge.source===hours.id)).toHaveLength(1);
});
