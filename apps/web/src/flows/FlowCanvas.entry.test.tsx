// @vitest-environment jsdom
import {fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {AUTOMATION_NODE_CATALOG_V1,welcomeFlow} from '@jrc/contracts';
import {FlowCanvas} from './FlowCanvas.js';
it('edits only the canonical message trigger with an explicit versioned opt-in',()=>{
 const graph=welcomeFlow(),change=vi.fn();render(<FlowCanvas graph={graph} editable catalog={AUTOMATION_NODE_CATALOG_V1} onChange={change}/>);
 fireEvent.click(screen.getByRole('button',{name:'Configurar condições de entrada'}));
 expect(change.mock.lastCall?.[0].nodes[0].data).toMatchObject({entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ALWAYS'});
});
it('exposes once-per-conversation and keyword controls without unsupported events',()=>{
 const graph=welcomeFlow();graph.nodes[0]!.data={entryConfigVersion:1,trigger:'MESSAGE_RECEIVED',reentry:'ALWAYS'};
 const change=vi.fn();render(<FlowCanvas graph={graph} editable catalog={AUTOMATION_NODE_CATALOG_V1} onChange={change}/>);
 fireEvent.change(screen.getByRole('combobox',{name:'Reexecução'}),{target:{value:'ONCE_PER_CONVERSATION'}});
 expect(change.mock.lastCall?.[0].nodes[0].data.reentry).toBe('ONCE_PER_CONVERSATION');
 expect(screen.getByText(/Uma automação vinculada por caixa/)).toBeVisible();
 expect(screen.queryByRole('option',{name:/contato criado|CRM|campanha/i})).toBeNull();
});
it('does not offer canonical entry configuration or typed capture in the legacy editor',()=>{
 const graph=welcomeFlow();render(<FlowCanvas graph={graph} editable onChange={vi.fn()}/>);
 expect(screen.queryByRole('button',{name:'Configurar condições de entrada'})).toBeNull();
});
