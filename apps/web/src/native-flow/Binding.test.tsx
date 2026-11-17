// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import { NativeBinding } from './Binding.js';
import type { NativeEditorOptions } from './transport.js';
const id = '11111111-2222-4333-8444-555555555555', integration = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const handle = '12345678-1234-4234-8234-123456789abc';
function mount(request: NativeEditorOptions['request']) {
  render(<MemoryRouter initialEntries={[`/automations/${id}/bind`]}><Routes><Route path="/automations/:id/bind" element={
    <NativeBinding options={{ accountId: 3, handleId: handle, integrationIds: [integration], request,
      inboxNames: { 2: 'Suporte JRC' }, context: { scopes: ['flow:read','flow:bind'] } }} />
  } /></Routes></MemoryRouter>);
}
it('requires a published version before preparing ownership of the box', async () => {
  const request = vi.fn<NativeEditorOptions['request']>(async (_method, path) => path.endsWith('/targets')
    ? { data: [{ integrationId: integration, inboxId: 2, ownerRevision: 4 }] } : { activeVersion: null });
  mount(request); await screen.findByRole('option', { name: 'Suporte JRC' });
  fireEvent.click(screen.getByRole('button', { name: 'Preparar e vincular' }));
  await screen.findByText('Publique uma versão antes de vincular.');
  expect(request.mock.calls.some(call => call[0] === 'post')).toBe(false);
});
it('consults an uncertain activation without repeating prepare or bind blindly', async () => {
  const request = vi.fn<NativeEditorOptions['request']>(async (method, path) => {
    if (path.endsWith('/targets')) return { data: [{ integrationId: integration, inboxId: 2, ownerRevision: 4 }] };
    if (path.endsWith('/scope')) return { revision: 2 };
    if (path.endsWith('/prepare')) throw new Error('Conexão interrompida.');
    if (path.endsWith('/cutover') && method === 'get') return { id: handle, revision: 1, phase: 'UNKNOWN', expectedOwnerRevision: 4, ready: false };
    return { activeVersion: 1 };
  });
  mount(request); await screen.findByRole('option', { name: 'Suporte JRC' });
  fireEvent.click(screen.getByRole('button', { name: 'Preparar e vincular' }));
  await screen.findByText(/Conexão interrompida/);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar ativação' }));
  await waitFor(() => expect(request.mock.calls.some(call => call[0] === 'get' && call[1].endsWith('/cutover'))).toBe(true));
  expect(request.mock.calls.filter(call => call[0] === 'post')).toHaveLength(1);
  expect(screen.getByText(/aguardando reconciliação/i)).toBeVisible();
});

it.each(['before-prepare', 'after-bind'] as const)('does not confirm another activated cutover after a lost ACK %s', async stage => {
  const intended = 'abcdefab-1234-4234-8234-123456789abc';
  const request = vi.fn<NativeEditorOptions['request']>(async (method, path) => {
    if (path.endsWith('/targets')) return { data: [{ integrationId: integration, inboxId: 2, ownerRevision: 4 }] };
    if (path.endsWith('/scope')) return { revision: 2 };
    if (path.endsWith('/prepare')) {
      if (stage === 'before-prepare') throw new Error('Conexão interrompida antes da preparação.');
      return { id: intended, revision: 1, phase: 'DRAINED' };
    }
    if (path.endsWith('/bindings')) throw new Error('ACK do vínculo perdido.');
    if (path.endsWith('/cutover') && method === 'get') return { id: handle, revision: 1, phase: 'ACTIVATED', expectedOwnerRevision: 3, ready: false };
    return { activeVersion: 2 };
  });
  mount(request); await screen.findByRole('option', { name: 'Suporte JRC' });
  fireEvent.click(screen.getByRole('button', { name: 'Preparar e vincular' }));
  await screen.findByText(stage === 'before-prepare' ? /interrompida antes/ : /ACK do vínculo perdido/);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar ativação' }));
  await waitFor(() => expect(request.mock.calls.some(call => call[0] === 'get' && call[1].endsWith('/cutover'))).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Consultar ativação' })).toBeEnabled());

  expect(screen.queryByText(/Ativação confirmada|Vínculo confirmado/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Consultar ativação' })).toBeVisible();
  expect(request.mock.calls.filter(call => call[1].endsWith('/prepare'))).toHaveLength(1);
  expect(request.mock.calls.filter(call => call[1].endsWith('/bindings'))).toHaveLength(stage === 'before-prepare' ? 0 : 1);
});

it('allows a new preparation after confirmed rollback with the freshly read owner revision', async () => {
  let targetReads = 0, prepareCalls = 0;
  const request = vi.fn<NativeEditorOptions['request']>(async (method, path) => {
    if (path.endsWith('/targets')) return { data: [{ integrationId: integration, inboxId: 2, ownerRevision: ++targetReads === 1 ? 4 : 7 }] };
    if (path.endsWith('/scope')) return { revision: 2 };
    if (path.endsWith('/prepare')) {
      if (++prepareCalls === 1) throw new Error('Preparação pendente de confirmação.');
      return { id: handle, revision: 2, phase: 'DRAINED' };
    }
    if (path.endsWith('/cutover') && method === 'get') return { id: handle, revision: 1, phase: 'ROLLED_BACK', expectedOwnerRevision: 4, ready: false };
    return { activeVersion: 2 };
  });
  mount(request); await screen.findByRole('option', { name: 'Suporte JRC' });
  fireEvent.click(screen.getByRole('button', { name: 'Preparar e vincular' }));
  await screen.findByText(/Preparação pendente de confirmação/);
  fireEvent.click(screen.getByRole('button', { name: 'Consultar ativação' }));
  const retry = await screen.findByRole('button', { name: 'Preparar e vincular' });
  fireEvent.click(retry);
  await screen.findByText(/Vínculo confirmado/);

  expect(request.mock.calls.filter(call => call[1].endsWith('/prepare'))[1]?.[2]).toEqual({ expectedOwnerRevision: 7 });
});

it.each(['static','profile'])('binds %s with a real channelId and read+bind session without edit, preserving profile CAS',async(kind)=>{
 const boxOrg='11111111-1111-4111-8111-111111111111',boxChannel='22222222-2222-4222-8222-222222222222';
 const scope={organizationId:boxOrg,channelId:boxChannel,integrationId:integration,destinationRevision:1,accountId:3,inboxId:2};
 const catalog={scope,observedAt:'2030-01-01T00:00:00.000Z',credentialRevision:1,teams:[{id:10,name:'Comercial',autoAssignment:false}],agents:[{id:1,name:'Ana',inboxMember:true}],labels:[],attributes:[],hours:{enabled:false,timezone:null,days:[]},remoteBot:null,inboxPolicy:{greetingEnabled:false,autoAssignmentEnabled:false},capabilities:{teams:'SUPPORTED',agents:'SUPPORTED',inboxMembership:'SUPPORTED',labels:'SUPPORTED',attributes:'SUPPORTED',hours:'SUPPORTED',agentBot:'SUPPORTED',signatures:'UNVERIFIED',controlEvents:'SUPPORTED',initialPending:'SUPPORTED'}};
 const config={schemaVersion:1,routes:[{routeKey:'sales',teamId:10,mode:'AGENT',membership:'ALL',agentIds:[]}]},snapshot={schemaVersion:1,profileRevision:3,scope,credentialRevision:1,routes:[{routeKey:'sales',teamId:10,teamName:'Comercial',mode:'AGENT',agents:[{id:1,name:'Ana'}]}]};
 const routing={schemaVersion:1,scope:{organizationId:boxOrg,automationId:id,version:2,channelId:boxChannel},
 routes:[{routeKey:'sales',labels:{pt:'Comercial',en:'Sales'},mode:'AGENT'}],catalog,teamMembers:[],rulesCheck:'UNVERIFIED',
 profile:{organizationId:boxOrg,automationId:id,version:2,channelId:boxChannel,revision:3,activeRevision:null,config,snapshot}};
 const request=vi.fn<NativeEditorOptions['request']>(async(_method,path)=>{
  if(path.endsWith('/targets'))return {data:[{integrationId:integration,channelId:boxChannel,inboxId:2,ownerRevision:4}]};
  if(path.includes('/box-routing?'))return kind==='profile'?routing:{...routing,routes:[],profile:null};
  if(path.endsWith('/scope'))return {revision:1};
  if(path.endsWith('/prepare'))return {id:handle,revision:1,phase:'DRAINED'};
  if(path.endsWith('/bindings'))return {ownerRevision:5};
  return {activeVersion:2};
 });
 mount(request);await screen.findByRole('option',{name:'Suporte JRC'});
 fireEvent.click(screen.getByRole('button',{name:'Preparar e vincular'}));
 await screen.findByText(/Vínculo confirmado/);
 const payload=request.mock.calls.find(call=>call[1].endsWith('/bindings'))?.[2];
 expect(payload).toMatchObject({version:2,expectedOwnerRevision:4});
 if(kind==='profile')expect(payload).toHaveProperty('expectedProfileRevision',3);else expect(payload).not.toHaveProperty('expectedProfileRevision');
 const paths=request.mock.calls.map(call=>call[1]);expect(paths.findIndex(path=>path.includes('/box-routing?'))).toBeLessThan(paths.findIndex(path=>path.endsWith('/prepare')));
});
