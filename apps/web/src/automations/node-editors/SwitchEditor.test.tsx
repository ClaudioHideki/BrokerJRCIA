// @vitest-environment jsdom
import {useState} from 'react';
import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {SwitchEditor} from './SwitchEditor.js';
import type {FlowNode} from '@jrc/contracts';
const initial:FlowNode={id:'switch',type:'switch',label:'Decisão',position:{x:0,y:0},data:{switchVersion:1,variable:'message',cases:[{id:'first',label:'Primeiro',value:'1'}]}};
function fixture(editable=true){const changed=vi.fn();function Harness(){const [node,setNode]=useState(initial);return <SwitchEditor node={node} nodes={[node]} editable={editable} onChange={data=>{changed(data);setNode({...node,data});}}/>;}render(<Harness/>);return changed;}
it('edits scalar types without losing the stable output identity',()=>{
 const changed=fixture();fireEvent.change(screen.getByLabelText('Tipo do caso 1'),{target:{value:'number'}});
 fireEvent.change(screen.getByLabelText('Valor do caso 1'),{target:{value:'1'}});
 fireEvent.change(screen.getByLabelText('Nome da saída 1'),{target:{value:'Financeiro'}});
 expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({cases:[{id:'first',label:'Financeiro',value:1}]});
 expect(screen.getByText(/texto.*número/i)).toBeVisible();
});
it('adds cases with distinct stable ids and makes removal explicit',()=>{
 const changed=fixture();fireEvent.click(screen.getByRole('button',{name:'Adicionar caso'}));
 const cases=changed.mock.calls.at(-1)![0].cases;expect(cases).toHaveLength(2);expect(cases[1].id).not.toBe('first');
 fireEvent.click(screen.getByRole('button',{name:'Remover caso 1'}));
 expect(changed.mock.calls.at(-1)![0].cases[0].id).toBe(cases[1].id);
 expect(screen.getByText(/conexões.*revisadas/i)).toBeVisible();
});
it('preserves invalid numeric input for validation instead of converting it to zero',()=>{
 const changed=fixture();fireEvent.change(screen.getByLabelText('Tipo do caso 1'),{target:{value:'number'}});
 fireEvent.change(screen.getByLabelText('Valor do caso 1'),{target:{value:''}});
 expect(changed.mock.calls.at(-1)![0].cases[0].value).toBeUndefined();expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
});
it('does not offer object or list comparisons and keeps the default branch explained',()=>{
 fixture();expect(screen.queryByRole('option',{name:'Objeto'})).not.toBeInTheDocument();expect(screen.queryByRole('option',{name:'Lista'})).not.toBeInTheDocument();
 expect(screen.getByText(/saída padrão/i)).toBeVisible();
});
it('disables mutations in a published read-only graph',()=>{
 const changed=fixture(false);expect(screen.getByLabelText('Tipo do caso 1')).toBeDisabled();expect(screen.getByRole('button',{name:'Adicionar caso'})).toBeDisabled();expect(changed).not.toHaveBeenCalled();
});
it('never reuses the identity of a removed output when adding another case',()=>{
 const changed=fixture();fireEvent.click(screen.getByRole('button',{name:'Adicionar caso'}));
 const old=changed.mock.calls.at(-1)![0].cases[1].id;
 fireEvent.click(screen.getByRole('button',{name:'Remover caso 2'}));fireEvent.click(screen.getByRole('button',{name:'Adicionar caso'}));
 expect(changed.mock.calls.at(-1)![0].cases[1].id).not.toBe(old);
});
