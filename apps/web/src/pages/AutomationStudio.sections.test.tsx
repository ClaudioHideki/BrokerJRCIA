// @vitest-environment jsdom
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router';
import {afterEach,expect,it,vi} from 'vitest';
import {AUTOMATION_NODE_CATALOG_V1,welcomeFlow} from '@jrc/contracts';
import {SessionProvider} from '../auth/SessionProvider.js';
import type {ApiClient} from '../api/client.js';
import {AutomationEditorPage} from './AutomationStudio.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',graph=welcomeFlow();
afterEach(()=>sessionStorage.clear());
function mount(options:{role?:string;archived?:boolean;canEdit?:boolean}={}){const paths:string[]=[],organization={id:org,name:'Teste',slug:'teste',role:options.role??'OWNER'};
 const request=async(path:string)=>{paths.push(path);
  if(path===`/v1/automations/${id}`)return{schemaVersion:1,id,organizationId:org,name:'Flow',lifecycleStatus:options.archived?'ARCHIVED':'DRAFT',draft:{revision:1,graph},activeVersion:null,updatedAt:'2030-01-01T00:00:00Z'};
  if(path==='/v1/automation-nodes')return{data:AUTOMATION_NODE_CATALOG_V1};if(path==='/v1/automations/status')return{enabled:true,canEdit:options.canEdit??true,canSimulate:true,canPublish:true};
  if(path.endsWith('/validate'))return{valid:false,diagnostics:[{nodeId:graph.nodes[1]!.id,field:'data.text',code:'INVALID_CONFIG',message:'Revise a mensagem'}]};
  if(path.startsWith('/v1/executions?'))return{data:[],nextCursor:null,period:{from:'2030-01-01T00:00:00Z',to:'2030-01-02T00:00:00Z'},metrics:{total:0,completed:0,active:0,failed:0,unknown:0,canceled:0,handoff:0,completionRate:null}};
  throw Error(path);
 };
 const client={request,restore:async()=>({user:{id:org,email:'test@example.test'},activeOrganization:organization,organizations:[organization]}),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as unknown as ApiClient;
 render(<SessionProvider client={client}><MemoryRouter initialEntries={[`/automations/${id}/edit`]}><Routes><Route path="/automations/:id/edit" element={<AutomationEditorPage/>}/></Routes></MemoryRouter></SessionProvider>);return paths;
}
it('provides four accessible areas with keyboard selection and a real scoped execution query',async()=>{
 const paths=mount();const editor=await screen.findByRole('tab',{name:'Editor'});
 expect(screen.getAllByRole('tab')).toHaveLength(4);expect(editor).toHaveAttribute('aria-selected','true');
 editor.focus();fireEvent.keyDown(editor,{key:'ArrowRight'});
 expect(screen.getByRole('tab',{name:'Configurações'})).toHaveFocus();expect(screen.getByRole('tabpanel',{name:'Configurações'})).toBeVisible();
 fireEvent.click(screen.getByRole('tab',{name:'Execuções'}));
 expect(await screen.findByText('Nenhuma execução encontrada.')).toBeVisible();
 expect(paths.some(path=>path.startsWith('/v1/executions?')&&path.includes('automationId='+id)&&path.includes('from='))).toBe(true);
});
it('preserves canvas edits and undo when switching configuration and playground areas',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:'Configurar '+graph.nodes[1]!.label}));
 fireEvent.change(screen.getByRole('textbox',{name:'Mensagem'}),{target:{value:'Texto editado'}});
 fireEvent.click(screen.getByRole('tab',{name:'Configurações'}));fireEvent.click(screen.getByRole('tab',{name:'Playground'}));fireEvent.click(screen.getByRole('tab',{name:'Editor'}));
 expect(screen.getByRole('textbox',{name:'Mensagem'})).toHaveValue('Texto editado');
 fireEvent.click(screen.getByRole('button',{name:'Desfazer'}));expect(screen.getByRole('textbox',{name:'Mensagem'})).toHaveValue(String(graph.nodes[1]!.data.text));
});
it('navigates a validation diagnostic to the corresponding node editor',async()=>{
 mount();fireEvent.click(await screen.findByRole('button',{name:'Validar'}));
 fireEvent.click(await screen.findByRole('button',{name:/Corrigir.*Revise a mensagem/}));
 expect(screen.getByRole('tab',{name:'Editor'})).toHaveAttribute('aria-selected','true');
 await waitFor(()=>expect(screen.getByRole('textbox',{name:'Nome do bloco'})).toHaveValue(graph.nodes[1]!.label));
});
it.each([{role:'VIEWER'},{archived:true},{canEdit:false}])('preserves console read-only validation without enabling simulation: %j',async options=>{
 const paths=mount(options);const validate=await screen.findByRole('button',{name:'Validar'});
 expect(validate).toBeEnabled();fireEvent.click(validate);
 await screen.findByRole('button',{name:/Corrigir.*Revise a mensagem/});
 expect(paths.some(path=>path.endsWith('/validate'))).toBe(true);
 expect(screen.getByRole('button',{name:'Testar'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'Exportar JSON'})).toBeEnabled();
});
