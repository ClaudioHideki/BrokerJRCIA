// @vitest-environment jsdom
import {act,render,screen,waitFor} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {WhatsAppGroupEventsConfiguration} from './WhatsAppGroupEventsConfiguration.js';
import {ApiClientError,type ApiClient} from '../api/client.js';
const org='11111111-1111-4111-8111-111111111111',channel='22222222-2222-4222-8222-222222222222';
const observation={schemaVersion:1,organizationId:org,channelId:channel,status:'UNKNOWN',operationId:'33333333-3333-4333-8333-333333333333',
  configurationRevision:2,observedAt:null,updatedAt:'2026-10-08T11:00:00.000Z',observedIdentityRevision:1,observedCatalogRevision:1,
  safeError:'CONFIGURATION_UNKNOWN',nextAction:'RECONCILE_READ_ONLY'};
function client(request:ApiClient['request']){let purge!:()=>void;return {api:{request,registerTenantPurge:(fn:()=>void)=>{purge=fn;return()=>{};}} as ApiClient,purge:()=>purge()};}
it('shows uncertainty as read-only reconciliation and never promises a fresh catalog',async()=>{
  const request=vi.fn().mockResolvedValueOnce(observation).mockResolvedValueOnce({...observation,status:'CONFIRMED',observedAt:'2026-10-08T11:01:00.000Z',safeError:null,nextAction:'UPDATE_GROUPS'}),c=client(request);
  const view=render(<WhatsAppGroupEventsConfiguration client={c.api} channelId={channel} organizationId={org} revision={0}/>);
  expect(await screen.findByText('A configuração dos eventos aguarda confirmação. Atualizar grupos fará somente a conferência desta configuração.')).toBeVisible();
  expect(request.mock.calls[0]?.[0]).toBe(`/v1/channels/${channel}/whatsapp-group-events-configuration`);
  view.rerender(<WhatsAppGroupEventsConfiguration client={c.api} channelId={channel} organizationId={org} revision={1}/>);
  expect(await screen.findByText('Recebimento de eventos de grupos configurado.')).toBeVisible();
  expect(screen.queryByText('Catálogo atual')).toBeNull();
});
it('rejects a configuration response for another company and clears the view on loss of grant',async()=>{
  const request=vi.fn().mockResolvedValueOnce({...observation,organizationId:'44444444-4444-4444-8444-444444444444'})
    .mockRejectedValueOnce(new ApiClientError('private token',403)),c=client(request);
  const view=render(<WhatsAppGroupEventsConfiguration client={c.api} channelId={channel} organizationId={org} revision={0}/>);
  expect(await screen.findByText('Não foi possível conferir a configuração dos eventos de grupos.')).toBeVisible();
  view.rerender(<WhatsAppGroupEventsConfiguration client={c.api} channelId={channel} organizationId={org} revision={1}/>);
  await waitFor(()=>expect(request).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/private token/)).toBeNull();expect(screen.queryByText(/aguarda confirmação/)).toBeNull();
});
it('does not revive an old tenant observation after its request is purged',async()=>{
  let resolve!:(value:unknown)=>void;const pending=new Promise<unknown>(yes=>{resolve=yes;}),c=client(vi.fn().mockReturnValue(pending));
  render(<WhatsAppGroupEventsConfiguration client={c.api} channelId={channel} organizationId={org} revision={0}/>);
  await waitFor(()=>expect(c.api.request).toHaveBeenCalledTimes(1));
  act(()=>c.purge());await act(async()=>resolve(observation));
  expect(screen.queryByText(/aguarda confirmação/)).toBeNull();
});
