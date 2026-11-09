// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent} from '@testing-library/react';
import {DirectoryMenuEditor,directoryMenuDefaults} from './DirectoryMenuEditor.js';
const routes=[{routeKey:'sales',labels:{pt:'Comercial',en:'Sales'},mode:'AGENT' as const}];
it('initializes and edits the logical menu without integration or human IDs',()=>{
 const data=directoryMenuDefaults(routes),change=vi.fn(),create=vi.fn();
 render(<DirectoryMenuEditor node={{id:'menu',type:'directory-menu',label:'Atendentes',position:{x:0,y:0},data}} routes={routes} editable onChange={change} onCreateRoute={create}/>);
 expect(screen.getByLabelText('Departamento do menu')).toHaveValue('sales');
 fireEvent.change(screen.getByLabelText('Texto do menu de atendentes'),{target:{value:'Olá {{nome}}, escolha'}});
 expect(change).toHaveBeenLastCalledWith(expect.objectContaining({text:'Olá {{nome}}, escolha',routeKey:'sales'}));
 fireEvent.change(screen.getByLabelText('Idioma do menu de atendentes'),{target:{value:'en'}});expect(change).toHaveBeenLastCalledWith(expect.objectContaining({language:'en'}));
 fireEvent.change(screen.getByLabelText('Máximo de tentativas'),{target:{value:'5'}});expect(change).toHaveBeenLastCalledWith(expect.objectContaining({maxAttempts:5}));
 fireEvent.change(screen.getByLabelText('Prazo de resposta em segundos'),{target:{value:'600'}});expect(change).toHaveBeenLastCalledWith(expect.objectContaining({timeoutSeconds:600}));
 fireEvent.change(screen.getByLabelText('Novo departamento em português'),{target:{value:'Suporte'}});fireEvent.change(screen.getByLabelText('Novo departamento em inglês'),{target:{value:'Support'}});
 fireEvent.click(screen.getByRole('button',{name:'Adicionar departamento ao modelo'}));expect(create).toHaveBeenCalledWith('Suporte','Support');
 expect(JSON.stringify(data)).not.toMatch(/integrationId|agentId|teamId/);
});
