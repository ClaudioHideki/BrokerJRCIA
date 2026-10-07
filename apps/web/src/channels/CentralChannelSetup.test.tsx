// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {afterEach,expect,it,vi} from 'vitest';
import type {ApiClient} from '../api/client.js';
import {CentralChannelSetup} from './CentralChannelSetup.js';
const org='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',id='10000000-0000-4000-8000-000000000003';
const preview={expectedCredentialVersion:1,expectedDestinationRevision:1,expectedBotId:17,expectedRemoteFingerprint:'a'.repeat(64)};
const op={id,channelId:null,integrationId:id,inboxId:9,status:'PENDING',step:'DETACH',revision:1,reconciliationRequired:false,rollbackStep:null};
afterEach(()=>sessionStorage.clear());
const mount=(request:ApiClient['request'])=>render(<MemoryRouter><CentralChannelSetup organizationId={org} tenantRevision={1} client={{request,registerTenantPurge:()=>()=>{}} as unknown as ApiClient}/></MemoryRouter>);
it('requires explicit replacement and submits the observed central revisions without a physical identity',async()=>{
 const request=vi.fn(async(path:string,init?:{body?:string})=>{
  if(path==='/v1/channels/central/inboxes')return {data:[{id:9,name:'Synthetic inbox',channelType:'Channel::Whatsapp'}]};
  if(path.endsWith('/preview'))return preview;
  if(path==='/v1/channels'){expect(JSON.parse(init!.body!)).toEqual({provider:'CENTRAL',name:'Synthetic central',inboxId:9,...preview,replaceExistingBot:true});return {provider:'CENTRAL',pending:true,operation:op};}
  if(path.endsWith('/advance'))return {...op,status:'UNKNOWN',revision:3,reconciliationRequired:true};
  throw new Error('Unexpected synthetic route');
 }) as ApiClient['request'];mount(request);
 fireEvent.change(await screen.findByLabelText('Caixa existente na central'),{target:{value:'9'}});
 await screen.findByText(/bot anterior.*17/i);
 fireEvent.change(screen.getByLabelText('Nome no Broker'),{target:{value:'Synthetic central'}});
 expect(screen.getByRole('button',{name:'Preparar canal central'})).toBeDisabled();
 fireEvent.click(screen.getByLabelText(/Autorizar a substituição/));
 fireEvent.click(screen.getByRole('button',{name:'Preparar canal central'}));
 await screen.findByRole('button',{name:'Reconciliar por consulta'});
 expect(request).toHaveBeenCalledWith('/v1/channels',expect.objectContaining({method:'POST'}));
 expect(screen.queryByText(/conexão.*confirmada/i)).toBeNull();
});
it('discards a late operation result after the tenant changes',async()=>{
 let release:(v:unknown)=>void=()=>{};
 const request=vi.fn(()=>new Promise(r=>{release=r;})) as ApiClient['request'];
 const view=render(<MemoryRouter><CentralChannelSetup organizationId={org} tenantRevision={1} operationId={id} client={{request,registerTenantPurge:()=>()=>{}} as unknown as ApiClient}/></MemoryRouter>);
 const replacement=vi.fn(async()=>({data:[]})) as ApiClient['request'];
 view.rerender(<MemoryRouter><CentralChannelSetup organizationId={other} tenantRevision={2} client={{request:replacement,registerTenantPurge:()=>()=>{}} as unknown as ApiClient}/></MemoryRouter>);
 await act(async()=>release(op));await waitFor(()=>expect(replacement).toHaveBeenCalled());
 expect(screen.queryByText('DETACH')).toBeNull();expect(screen.queryByRole('button',{name:'Continuar configuração'})).toBeNull();
});
it('reloads the operation associated with a channel and offers an explicit rollback',async()=>{
 const request=vi.fn(async(path:string)=>path.endsWith('/rollback')?{...op,status:'ROLLED_BACK',rollbackStep:'VERIFY'}:{...op,status:'COMPLETE',channelId:id}) as ApiClient['request'];
 render(<MemoryRouter><CentralChannelSetup organizationId={org} tenantRevision={1} channelId={id} client={{request,registerTenantPurge:()=>()=>{}} as unknown as ApiClient}/></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button',{name:'Reverter para o bot anterior'}));
 await screen.findByText(/Reversão conferida/);
 expect(request).toHaveBeenCalledWith(`/v1/channels/${id}/central-operation`,expect.anything());
 expect(request).toHaveBeenCalledWith(`/v1/channels/central/operations/${id}/rollback`,expect.objectContaining({method:'POST'}));
});
it('records the operation immediately and reloads the authoritative revision after a lost advance response',async()=>{
 const persisted=vi.fn();let advanced=false;
 const request=vi.fn(async(path:string)=>{
  if(path==='/v1/channels/central/inboxes')return {data:[{id:9,name:'Synthetic',channelType:'Channel::Whatsapp'}]};
  if(path.endsWith('/preview'))return preview;
  if(path==='/v1/channels')return {provider:'CENTRAL',pending:true,operation:op};
  if(path.endsWith('/advance')){expect(persisted).toHaveBeenCalledWith(id);advanced=true;throw new Error('Synthetic response loss');}
  if(path.endsWith(id)){expect(advanced).toBe(true);return {...op,revision:3,step:'CREATE'};}
  throw new Error('Unexpected route');
 }) as ApiClient['request'];
 render(<MemoryRouter><CentralChannelSetup organizationId={org} tenantRevision={1} client={{request,registerTenantPurge:()=>()=>{}} as unknown as ApiClient} onOperation={persisted}/></MemoryRouter>);
 fireEvent.change(await screen.findByLabelText('Caixa existente na central'),{target:{value:'9'}});await screen.findByText(/Bot anterior/);
 fireEvent.change(screen.getByLabelText('Nome no Broker'),{target:{value:'Synthetic'}});fireEvent.click(screen.getByLabelText(/Autorizar/));fireEvent.click(screen.getByRole('button',{name:'Preparar canal central'}));
 await screen.findByText(/Preparar o bot do Broker.*PENDING/);expect(screen.getByRole('button',{name:'Atualizar estado salvo'})).toBeEnabled();
});
it('recovers a prepare whose response was lost using the tenant scoped persisted key after reload',async()=>{
 sessionStorage.setItem(`central-cutover:${org}:1`,'synthetic-key');
 const request=vi.fn(async()=>op) as ApiClient['request'];mount(request);
 await screen.findByRole('button',{name:'Cancelar preparação'});
 expect(request).toHaveBeenCalledWith('/v1/channels/central/operations/by-key/synthetic-key',expect.anything());
});
it('clears a completed operation key so a later new channel can select another inbox',async()=>{
 sessionStorage.setItem(`central-cutover:${org}:1`,'old-key');
 const request=vi.fn(async(path:string)=>path.includes('/by-key/')?{...op,status:'COMPLETE',channelId:id}:{data:[{id:10,name:'Second inbox',channelType:'Channel::Api'}]}) as ApiClient['request'];
 const view=mount(request);await screen.findByText(/Bot e vínculo conferidos/);expect(sessionStorage.getItem(`central-cutover:${org}:1`)).toBeNull();view.unmount();
 mount(request);expect(await screen.findByRole('option',{name:'Second inbox'})).toBeInTheDocument();
});
it('loads the inbox list after a persisted prepare key is proven absent on reload',async()=>{
 sessionStorage.setItem(`central-cutover:${org}:1`,'rejected-key');
 const request=vi.fn(async(path:string)=>{if(path.includes('/by-key/'))throw Object.assign(new Error('Absent'),{status:404});return {data:[{id:9,name:'Synthetic',channelType:'Channel::Api'}]};}) as ApiClient['request'];mount(request);
 await screen.findByRole('option',{name:'Synthetic'});expect(sessionStorage.getItem(`central-cutover:${org}:1`)).toBeNull();
});
