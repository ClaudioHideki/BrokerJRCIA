// @vitest-environment jsdom
import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {FlowNode} from '@jrc/contracts';
import {InputEditor} from './InputEditor.js';
const node:FlowNode={id:'capture',type:'input',label:'Resposta',position:{x:0,y:0},data:{inputConfigVersion:1,variable:'answer',timeoutSeconds:10}};
it('opts into validation explicitly and preserves an existing deadline',()=>{
 const change=vi.fn();render(<InputEditor node={node} editable onChange={change}/>);
 fireEvent.click(screen.getByRole('button',{name:'Validar resposta por tipo'}));
 expect(change).toHaveBeenCalledWith({...node.data,inputConfigVersion:2,inputType:'text',maxAttempts:3,errorMessage:'Resposta inválida. Confira o formato e tente novamente.'});
});
it('offers supported validators and explains the exhausted connection',()=>{
 const change=vi.fn();render(<InputEditor node={{...node,data:{...node.data,inputConfigVersion:2,inputType:'text',maxAttempts:3}}} editable onChange={change}/>);
 fireEvent.change(screen.getByRole('combobox',{name:'Tipo de resposta'}),{target:{value:'cnpj'}});
 expect(change.mock.lastCall?.[0]).toMatchObject({inputType:'cnpj'});
 expect(screen.getByText(/Conecte a saída.*tentativas/i)).toBeVisible();
 expect(screen.queryByRole('option',{name:/regex|localização/i})).toBeNull();
});
it('opts into V3 for image/file capture and describes the stored internal reference',()=>{
 const change=vi.fn();const data={...node.data,inputConfigVersion:2,inputType:'text',maxAttempts:3};
 const view=render(<InputEditor node={{...node,data}} editable onChange={change}/>);
 fireEvent.change(screen.getByRole('combobox',{name:'Tipo de resposta'}),{target:{value:'image'}});
 expect(change.mock.lastCall?.[0]).toMatchObject({inputConfigVersion:3,inputType:'image',maxAttempts:3,timeoutSeconds:10});
 view.rerender(<InputEditor node={{...node,data:change.mock.lastCall![0]}} editable onChange={change}/>);
 expect(screen.getByText(/referência interna.*não baixa/i)).toBeVisible();
});
