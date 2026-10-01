// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommercialPlans } from './CommercialPlans.js';
const plan={id:'00000000-0000-4000-8000-000000000001',planId:'00000000-0000-4000-8000-000000000002',version:1,name:'Fixture',flowsEnabled:true,limits:{maxInstances:1,maxUsers:5,messagesPerDay:10,maxPendingMessages:3}};
const assignment={organizationId:'00000000-0000-4000-8000-000000000003',planVersionId:plan.id,name:plan.name,version:1,revision:4,limits:plan.limits,flowsEnabled:true,overrides:{},usage:{connections:2,users:1,messagesAcceptedToday:3,pendingMessages:0,storageBytes:null,aiTokens:null}};
afterEach(cleanup);
describe('CommercialPlans',()=>{
 it('shows over-limit resources, unknown usage and sends explicit overrides with current revision',async()=>{
  const request=vi.fn(async(path:string,method?:string)=>method==='PUT'?{...assignment,revision:5}:path==='/commercial-plans'?{data:[plan]}:assignment);
  render(<CommercialPlans organizationId={assignment.organizationId} request={request} admin disabled={false}/>);
  expect(await screen.findByText(/Acima do limite: 1/)).toBeTruthy();
  expect(screen.getByText(/Armazenamento: indisponível/)).toBeTruthy();
  expect(screen.getByText(/IA: indisponível/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Exceção: Usuários'),{target:{value:'8'}});
  fireEvent.click(screen.getByText('Aplicar versão à empresa'));
  await waitFor(()=>expect(request).toHaveBeenCalledWith(`/organizations/${assignment.organizationId}/commercial-plan`,'PUT',{planVersionId:plan.id,expectedRevision:4,overrides:{maxUsers:8}}));
 });
 it('does not offer commercial mutation to support',async()=>{
  render(<CommercialPlans organizationId={assignment.organizationId} request={async()=>assignment} admin={false} disabled={false}/>);
  expect(await screen.findByText(/Armazenamento: indisponível/)).toBeTruthy();
  expect(screen.queryByText('Aplicar versão à empresa')).toBeNull();
 });
});
