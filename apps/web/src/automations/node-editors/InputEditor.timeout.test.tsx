// @vitest-environment jsdom
import {fireEvent,render,screen} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import type {FlowNode} from '@jrc/contracts';
import {InputEditor} from './InputEditor.js';
const node:FlowNode={id:'capture',type:'input',label:'Nome',position:{x:0,y:0},data:{inputConfigVersion:1,variable:'answer',text:'Nome?',timeoutSeconds:5}};
describe('capture deadline editor',()=>{
  it('lets an editor select a bounded deadline in seconds without exposing internal wait identity',()=>{
    const change=vi.fn();
    render(<InputEditor node={node} editable onChange={change}/>);
    fireEvent.change(screen.getByRole('spinbutton',{name:'Tempo para responder (segundos)'}),{target:{value:'15'}});
    expect(change).toHaveBeenCalledWith({...node.data,timeoutSeconds:15});
    expect(screen.queryByRole('textbox',{name:/waitId|deadline/i})).toBeNull();
  });
  it('shows invalid deadlines while preserving an editable draft',()=>{
    render(<InputEditor node={{...node,data:{...node.data,timeoutSeconds:0}}} editable onChange={vi.fn()}/>);
    expect(screen.getByRole('spinbutton',{name:'Tempo para responder (segundos)'})).toHaveAttribute('aria-invalid','true');
    expect(screen.getByRole('alert')).toHaveTextContent(/1.*604800/);
  });
  it('keeps a deadline read-only without permission',()=>{
    render(<InputEditor node={node} editable={false} onChange={vi.fn()}/>);
    expect(screen.getByRole('spinbutton',{name:'Tempo para responder (segundos)'})).toBeDisabled();
  });
});
