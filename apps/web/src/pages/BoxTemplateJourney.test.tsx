// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {oiaVisualReconstructionFlow} from '@jrc/contracts';
import {SessionProvider} from '../auth/SessionProvider.js';
import {AutomationsPage} from './AutomationStudio.js';
it('converts an unpublished imported draft from the Flow page without first configuring static destinations',async()=>{
 const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',createdId='33333333-3333-4333-8333-333333333333';
 const organization={id:org,name:'Empresa',slug:'empresa',role:'OWNER'},original={schemaVersion:1,id,organizationId:org,name:'OIA importada',lifecycleStatus:'DRAFT',activeVersion:null,draft:{revision:1,graph:oiaVisualReconstructionFlow()},updatedAt:'2030-01-01T00:00:00Z'};
 const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path==='/v1/automations/status')return {enabled:true,canEdit:true,canPublish:true};
  if(path===`/v1/automations/${id}`)return original;
  if(path==='/v1/automations'&&init?.method==='POST'){const body=JSON.parse(String(init.body));return {...original,id:createdId,name:body.name,draft:{revision:1,graph:body.graph}};}
  if(path==='/v1/automations')return {data:[original],nextCursor:null};throw Error(path);
 });
 const client={request,restore:async()=>({user:{id:org,email:'owner@example.test'},activeOrganization:organization,organizations:[organization]}),registerTenantPurge:()=>()=>{},subscribeToSessionExpiration:()=>()=>{}} as any;
 render(<SessionProvider client={client}><MemoryRouter><AutomationsPage/></MemoryRouter></SessionProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Usar configuração da caixa'}));
 await waitFor(()=>expect(request.mock.calls.some(([path,init])=>path==='/v1/automations'&&init?.method==='POST')).toBe(true));
 const create=request.mock.calls.find(([path,init])=>path==='/v1/automations'&&init?.method==='POST')!;
 expect(JSON.parse(String(create[1]!.body)).graph.nodes.filter((n:any)=>n.type==='handoff').every((n:any)=>n.data.handoffVersion===3)).toBe(true);
 expect(request.mock.calls.some(([path])=>path.endsWith('/publish')||path.endsWith('/bindings'))).toBe(false);
 expect(original.activeVersion).toBeNull();expect(await screen.findByRole('heading',{name:'OIA importada — por caixa'})).toBeVisible();
});
