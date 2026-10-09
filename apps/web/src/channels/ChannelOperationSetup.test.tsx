// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {MemoryRouter} from 'react-router';
import {expect,it,vi} from 'vitest';
import type {ApiClient} from '../api/client.js';
import {ChannelOperationSetup} from './ChannelOperationSetup.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const profile={schemaVersion:1,organizationId:org,channelId:id,messagingChannelId:id,observedAt:'2026-10-06T12:00:00Z',mode:'STANDALONE',transport:'BROKER_TRANSPORT',readiness:'READY',blockers:[],central:null,deliveryVerified:false,capabilitiesObservedAt:null,callbackObservedAt:null};
const mount=(request:ReturnType<typeof vi.fn>,props={organizationId:org,channelId:id,tenantRevision:1})=>render(<MemoryRouter><ChannelOperationSetup {...props} client={{request} as unknown as ApiClient}/></MemoryRouter>);
it('reads explicitly without a write and guides standalone through the Broker',async()=>{
 const request=vi.fn().mockResolvedValue(profile);mount(request);
 expect(request).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Conferir modo e configuração'}));
 await screen.findByText('Atendimento no Broker');expect(request).toHaveBeenCalledOnce();
 expect(screen.getByRole('link',{name:'Abrir atendimento no Broker'})).toHaveAttribute('href','/mensagens');
 expect(screen.getByText(/A configuração está pronta para o teste/)).toBeVisible();
 expect(screen.getByText(/entrega real ainda precisa/)).toBeVisible();
});
it('keeps a failed external central blocked and directs to existing onboarding',async()=>{
 const request=vi.fn().mockResolvedValue({...profile,mode:'CHATWOOT_EXTERNAL',readiness:'BLOCKED',blockers:['CONNECTION_NOT_READY'],central:{origin:'https://support.example.test',accountId:7,inboxId:9,integrationId:id,destinationRevision:2,credentialVersion:3}});mount(request);
 fireEvent.click(screen.getByRole('button',{name:'Conferir modo e configuração'}));
 await screen.findByText('Chatwoot externo');expect(screen.getByText('A caixa na central ainda não está pronta.')).toBeVisible();
 expect(screen.getByRole('link',{name:'Configurar central e caixa'})).toHaveAttribute('href','/integracoes');
 expect(screen.queryByRole('link',{name:'Abrir atendimento no Broker'})).toBeNull();
});
it('offers an existing repair action for each connection or central blocker without claiming delivery',async()=>{
 const request=vi.fn().mockResolvedValue({...profile,readiness:'BLOCKED',blockers:['TRANSPORT_NOT_CONNECTED','ACCOUNT_NOT_READY','CALLBACK_UNVERIFIED']});mount(request);
 fireEvent.click(screen.getByRole('button',{name:'Conferir modo e configuração'}));
 expect(await screen.findByRole('link',{name:'Conectar ou atualizar WhatsApp'})).toHaveAttribute('href','#channel-connect');
 expect(screen.getAllByRole('link',{name:'Conferir configuração na central'})).toHaveLength(2);
 expect(screen.queryByText(/entrega confirmada/i)).toBeNull();
});
it('rejects a profile from another tenant or box',async()=>{
 const request=vi.fn().mockResolvedValue({...profile,organizationId:other});mount(request);
 fireEvent.click(screen.getByRole('button',{name:'Conferir modo e configuração'}));
 await screen.findByRole('alert');expect(screen.queryByText('Atendimento no Broker')).toBeNull();
});
it('discards delayed data after a tenant revision or channel change',async()=>{
 let release:(v:unknown)=>void=()=>{};const request=vi.fn(()=>new Promise(r=>{release=r;}));
 const view=mount(request);fireEvent.click(screen.getByRole('button',{name:'Conferir modo e configuração'}));
 view.rerender(<MemoryRouter><ChannelOperationSetup organizationId={org} channelId={other} tenantRevision={2} client={{request} as unknown as ApiClient}/></MemoryRouter>);
 await act(async()=>release(profile));expect(screen.queryByText('Atendimento no Broker')).toBeNull();
 expect(screen.getByRole('button',{name:'Conferir modo e configuração'})).toBeEnabled();
});
it('sanitizes a server error and invalidates old readiness during a recheck',async()=>{
 const request=vi.fn().mockResolvedValueOnce(profile).mockRejectedValueOnce(new Error('secret tenant payload'));mount(request);
 fireEvent.click(screen.getByRole('button',{name:'Conferir modo e configuração'}));await screen.findByText('Atendimento no Broker');
 fireEvent.click(screen.getByRole('button',{name:'Conferir modo e configuração'}));await waitFor(()=>expect(screen.queryByText('Atendimento no Broker')).toBeNull());
 expect(await screen.findByRole('alert')).not.toHaveTextContent('secret');
});
