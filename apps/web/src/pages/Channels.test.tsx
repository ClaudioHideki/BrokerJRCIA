// @vitest-environment jsdom
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import { ApiClientError, type ApiClient } from '../api/client.js';
import { App } from '../app/App.js';

const org = '92776cb0-bcba-45c0-98a3-2937fefdfdaf';
const id = '519b77a6-a4e5-409a-85c8-d78fc155c525';
const account = '6fd7933a-80b7-4491-b081-a0fa8c2414d2';
const timestamp = '2030-01-01T12:00:00.000Z';
const session = { user: { id: account, email: 'owner@example.test' }, activeOrganization: { id: org, name: 'JRC', slug: 'jrc', role: 'OWNER' as const },
  organizations: [{ id: org, name: 'JRC', slug: 'jrc', role: 'OWNER' as const }] };
function client(request: ApiClient['request']): ApiClient { return { restore: vi.fn(async () => session), request,
  login: vi.fn(), selectOrganization: vi.fn(), switchOrganization: vi.fn(), logout: vi.fn(),
  registerTenantPurge: vi.fn(() => () => undefined), subscribeToSessionExpiration: vi.fn(() => () => undefined) } as unknown as ApiClient; }

describe('canonical channels UI', () => {
  it('queries groups with the messaging channel scope when the QR instance has a different ID', async () => {
    const messagingChannelId = '66666666-6666-4666-8666-666666666666';
    const channel = {schemaVersion:1,id,organizationId:org,provider:'QR',messagingChannelId,
      identity:{displayName:'Caixa de teste',maskedAddress:null},providerReference:{providerAccountId:account,instanceId:id},
      transportStatus:'CONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:timestamp,updatedAt:timestamp};
    const request = vi.fn(async(path:string)=>{
      if(path==='/v1/flows/status')return {enabled:true};
      if(path===`/v1/channels/${id}`)return channel;
      if(path===`/v1/channels/${id}/automation`)return {binding:null,ownerRevision:1};
      if(path==='/v1/automations')return {data:[]};
      if(path===`/v1/channels/${messagingChannelId}/whatsapp-groups?limit=50`)throw new ApiClientError('Catálogo não consultado',404,'synthetic-request','GROUP_CATALOG_NOT_READY');
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/channels/${id}`]}/>);
    expect(await screen.findByRole('heading',{name:'Grupos do WhatsApp'})).toBeVisible();
    await waitFor(()=>expect(request).toHaveBeenCalledWith(`/v1/channels/${messagingChannelId}/whatsapp-groups?limit=50`,expect.objectContaining({signal:expect.any(AbortSignal)})));
    expect(request).not.toHaveBeenCalledWith(`/v1/channels/${id}/whatsapp-groups?limit=50`,expect.anything());
  });
  it('preserves the chosen automation when the initial binding response arrives later', async () => {
    const automationId = '11111111-2222-4333-8444-555555555555';
    let release: (value: unknown) => void = () => {};
    const pendingBinding = new Promise(resolve => { release = resolve; });
    const channel = {schemaVersion:1,id,organizationId:org,provider:'QR',identity:{displayName:'Atendimento',maskedAddress:null},providerReference:{providerAccountId:account,instanceId:id},transportStatus:'CONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:timestamp,updatedAt:timestamp};
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/flows/status') return {enabled:true};
      if (path === `/v1/channels/${id}`) return channel;
      if (path === `/v1/channels/${id}/automation`) return pendingBinding;
      if (path === '/v1/automations') return {data:[{schemaVersion:1,id:automationId,organizationId:org,name:'Triagem',lifecycleStatus:'PUBLISHED',draft:{revision:1,graph:welcomeFlow()},activeVersion:1,updatedAt:timestamp}]};
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/channels/${id}`]}/>);
    await screen.findByRole('option',{name:'Triagem · v1'});
    fireEvent.change(screen.getByLabelText('Automação publicada'),{target:{value:automationId}});
    const button = screen.getByRole('button',{name:'Vincular automação'});
    const disabledWhileLoading = button.hasAttribute('disabled');
    await act(async () => { release({binding:null,ownerRevision:3}); await pendingBinding; });
    expect(screen.getByLabelText('Automação publicada')).toHaveValue(automationId);
    expect(disabledWhileLoading).toBe(true);
    expect(button).toBeEnabled();
  });
  it('shows the request ID when the inbox list is unavailable so support can trace the failure', async () => {
    const requestId = '85a17103-9f0d-4d86-b55d-4184597e17a8';
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('/v1/channels?pageSize=')) throw new ApiClientError('Serviço temporariamente indisponível. Tente novamente.', 503, requestId);
      return { data: [] };
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={['/channels']} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Serviço temporariamente indisponível');
    expect(screen.getByRole('alert')).toHaveTextContent(`Solicitação: ${requestId}`);
  });
  it('shows four independent states and keeps legacy list URL as a redirect', async () => {
    const request = vi.fn(async (path: string) => path === '/v1/flows/status' ? { enabled: true } : { data: [{
      schemaVersion: 1, id, organizationId: org, provider: 'QR', identity: { displayName: 'Atendimento', maskedAddress: null },
      providerReference: { providerAccountId: account, instanceId: id }, transportStatus: 'CONNECTED', providerStatus: 'READY',
      automationStatus: 'ACTIVE', humanStatus: 'DEGRADED', revision: 1, createdAt: timestamp, updatedAt: timestamp,
    }] }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={['/conexoes']} />);
    expect(await screen.findByRole('heading', { name: 'Caixas de entrada' })).toBeVisible();
    expect(await screen.findByText('Conectado')).toBeVisible();
    expect(screen.getByText(/Serviço WhatsApp: Pronto/)).toBeInTheDocument();
    expect(screen.getAllByText('Ativo').length).toBeGreaterThan(0);
    expect(screen.getByText('Com falha')).toBeVisible();
    await waitFor(() => expect(request).toHaveBeenCalledWith('/v1/channels?pageSize=50'));
  });

  it('loads a bounded next page of inboxes on demand', async () => {
    const secondId = 'f1654439-24f2-4cde-927a-e11754028789';
    const base = { schemaVersion: 1, organizationId: org, provider: 'QR',
      providerReference: { providerAccountId: account, instanceId: id }, transportStatus: 'CONNECTED', providerStatus: 'READY',
      automationStatus: 'UNBOUND', humanStatus: 'UNBOUND', revision: 1, createdAt: timestamp, updatedAt: timestamp };
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/channels?pageSize=50') return { data: [{ ...base, id, identity: { displayName: 'Caixa 1', maskedAddress: null } }], nextCursor: 'cursor1' };
      if (path === '/v1/channels?pageSize=50&cursor=cursor1') return { data: [{ ...base, id,
        identity: { displayName: 'Caixa 1 duplicada após atualização', maskedAddress: null } }, { ...base, id: secondId,
        providerReference: { ...base.providerReference, instanceId: secondId }, identity: { displayName: 'Caixa 2', maskedAddress: null } }], nextCursor: null };
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={['/channels']} />);

    expect(await screen.findByText('Caixa 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais caixas' }));
    expect(await screen.findByText('Caixa 2')).toBeVisible();
    expect(screen.queryByText('Caixa 1 duplicada após atualização')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Carregar mais caixas' })).not.toBeInTheDocument();
  });

  it('unlocks pagination when archived filter changes during an older load-more request', async () => {
    let finishOldPage!: (value: unknown) => void;
    const oldPage = new Promise(resolve => { finishOldPage = resolve; });
    const base = { schemaVersion: 1, id, organizationId: org, provider: 'QR',
      identity: { displayName: 'Caixa ativa', maskedAddress: null },
      providerReference: { providerAccountId: account, instanceId: id }, transportStatus: 'CONNECTED',
      providerStatus: 'READY', automationStatus: 'UNBOUND', humanStatus: 'UNBOUND', revision: 1,
      createdAt: timestamp, updatedAt: timestamp };
    const archivedId = 'c58013f8-7a60-4a55-b4fa-e3b4c56540a0';
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/channels?pageSize=50') return { data: [base], nextCursor: 'old-cursor' };
      if (path === '/v1/channels?pageSize=50&cursor=old-cursor') return oldPage;
      if (path === '/v1/channels?includeArchived=true&pageSize=50') return { data: [{ ...base,
        id: archivedId, providerReference: { ...base.providerReference, instanceId: archivedId },
        identity: { displayName: 'Caixa arquivada', maskedAddress: null }, archivedAt: timestamp }], nextCursor: 'new-cursor' };
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={['/channels']} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais caixas' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/v1/channels?pageSize=50&cursor=old-cursor'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mostrar arquivadas' }));
    expect(await screen.findByText('Caixa arquivada')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Carregar mais caixas' })).toBeEnabled();
    finishOldPage({ data: [], nextCursor: null });
    expect(screen.getByText('Caixa arquivada')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Carregar mais caixas' })).toBeEnabled();
  });

  it('offers both providers and includes identity and delivery verification in setup', async () => {
    const request = vi.fn(async (path: string) => path === '/v1/flows/status' ? { enabled: true } : {}) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={['/channels/new']} />);
    expect(await screen.findByRole('heading', { name: 'Configurar canal' })).toBeVisible();
    expect(screen.getByRole('button', { name: /WhatsApp por QR Code/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /WhatsApp oficial Meta/ })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Etapas da configuração' }).children).toHaveLength(5);
    expect(screen.getByText('Confirmar número e testar')).toBeVisible();
  });

  it('exposes status, reconnection, disconnection, rename and published automation controls', async () => {
    const channel = { schemaVersion: 1, id, organizationId: org, provider: 'QR',
      identity: { displayName: 'Atendimento', maskedAddress: null }, providerReference: { providerAccountId: account, instanceId: id },
      transportStatus: 'CONNECTED', providerStatus: 'READY', automationStatus: 'UNBOUND', humanStatus: 'UNBOUND', revision: 1,
      createdAt: timestamp, updatedAt: timestamp };
    const automationId = '11111111-2222-4333-8444-555555555555';
    const request = vi.fn(async (path: string) => {
      if (path === '/v1/flows/status') return { enabled: true };
      if (path === `/v1/channels/${id}`) return channel;
      if (path === `/v1/channels/${id}/automation`) return { binding: null };
      if (path === '/v1/automations') return { data: [{ schemaVersion: 1, id: automationId, organizationId: org,
        name: 'Triagem inteligente', lifecycleStatus: 'PUBLISHED', draft: { revision: 1, graph: welcomeFlow() },
        activeVersion: 2, updatedAt: timestamp }] };
      throw new Error(`Unexpected ${path}`);
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/channels/${id}`]} />);
    expect(await screen.findByRole('heading', { name: 'Atendimento' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Atualizar status' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reconectar' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Desconectar' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Salvar nome' })).toBeVisible();
    expect(await screen.findByRole('option', { name: 'Triagem inteligente · v2' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Vincular automação' })).toBeDisabled();
  });

  it('explica ao administrador o bloqueio de reconciliação sem sugerir novo QR', async () => {
    const channel = { schemaVersion: 1, id, organizationId: org, provider: 'QR',
      identity: { displayName: 'Atendimento', maskedAddress: null }, providerReference: { providerAccountId: account, instanceId: id },
      transportStatus: 'DISCONNECTED', providerStatus: 'READY', automationStatus: 'UNBOUND', humanStatus: 'UNBOUND', revision: 1,
      createdAt: timestamp, updatedAt: timestamp };
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/pair')) throw new ApiClientError('CONNECT_RECONCILIATION_REQUIRED', 409, undefined, 'CONNECT_RECONCILIATION_REQUIRED');
      if (path.endsWith('/automation')) return { binding: null };
      if (path === '/v1/automations') return { data: [] };
      return channel;
    }) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={[`/channels/${id}`]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar QR Code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Atualize o status');
    expect(screen.getByRole('alert')).toHaveTextContent('reconciliação');
    expect(screen.getByRole('alert')).not.toHaveTextContent('CONNECT_RECONCILIATION_REQUIRED');
  });
});

it('never renders an expired QR challenge and provides a new request action',async()=>{
 const channel={schemaVersion:1,id,organizationId:org,provider:'QR',identity:{displayName:'Parear',maskedAddress:null},providerReference:{providerAccountId:account,instanceId:id},transportStatus:'DISCONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:timestamp,updatedAt:timestamp};
 const request=vi.fn(async(path:string)=>{if(path.endsWith('/pair'))return {provider:'QR',channel,operationId:null,replayed:false,pending:false,reconciliationRequired:false,action:{type:'QR_CODE',encoding:'DATA_URL',value:'data:image/png;base64,abc',expiresAt:new Date(Date.now()-1000).toISOString()}};if(path.endsWith('/automation'))return {binding:null};if(path==='/v1/automations')return {data:[]};return channel;}) as ApiClient['request'];
 render(<App client={client(request)} initialEntries={['/channels/'+id]}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Gerar QR Code'}));
 expect(await screen.findByText('QR ou código expirado. Atualize o status antes de solicitar outro.')).toBeVisible();
 expect(screen.queryByRole('img',{name:'QR Code para conectar o WhatsApp'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Gerar QR Code'})).toBeEnabled();
});

it('renders a BASE64 pairing challenge as an image data URL',async()=>{
 const channel={schemaVersion:1,id,organizationId:org,provider:'QR',identity:{displayName:'Parear',maskedAddress:null},providerReference:{providerAccountId:account,instanceId:id},transportStatus:'DISCONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:timestamp,updatedAt:timestamp};
 const request=vi.fn(async(path:string)=>{if(path.endsWith('/pair'))return {provider:'QR',channel,operationId:null,replayed:false,pending:false,reconciliationRequired:false,action:{type:'QR_CODE',encoding:'BASE64',value:'aGVsbG8=',expiresAt:new Date(Date.now()+60000).toISOString()}};if(path.endsWith('/automation'))return {binding:null};if(path==='/v1/automations')return {data:[]};return channel;}) as ApiClient['request'];
 render(<App client={client(request)} initialEntries={['/channels/'+id]}/>);fireEvent.click(await screen.findByRole('button',{name:'Gerar QR Code'}));expect(await screen.findByRole('img',{name:'QR Code para conectar o WhatsApp'})).toHaveAttribute('src','data:image/png;base64,aGVsbG8=');
});
