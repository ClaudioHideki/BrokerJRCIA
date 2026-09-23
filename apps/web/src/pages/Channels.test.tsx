// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { welcomeFlow } from '@jrc/contracts';
import type { ApiClient } from '../api/client.js';
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
    await waitFor(() => expect(request).toHaveBeenCalledWith('/v1/channels'));
  });

  it('offers both providers and three customer setup steps', async () => {
    const request = vi.fn(async (path: string) => path === '/v1/flows/status' ? { enabled: true } : {}) as ApiClient['request'];
    render(<App client={client(request)} initialEntries={['/channels/new']} />);
    expect(await screen.findByRole('heading', { name: 'Configurar canal' })).toBeVisible();
    expect(screen.getByRole('button', { name: /WhatsApp por QR Code/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /WhatsApp oficial Meta/ })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Etapas da configuração' }).children).toHaveLength(3);
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
});

it('never renders an expired QR challenge and provides a new request action',async()=>{
 const channel={schemaVersion:1,id,organizationId:org,provider:'QR',identity:{displayName:'Parear',maskedAddress:null},providerReference:{providerAccountId:account,instanceId:id},transportStatus:'DISCONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:timestamp,updatedAt:timestamp};
 const request=vi.fn(async(path:string)=>{if(path.endsWith('/pair'))return {provider:'QR',channel,operationId:null,replayed:false,pending:false,reconciliationRequired:false,action:{type:'QR_CODE',encoding:'DATA_URL',value:'data:image/png;base64,abc',expiresAt:new Date(Date.now()-1000).toISOString()}};if(path.endsWith('/automation'))return {binding:null};if(path==='/v1/automations')return {data:[]};return channel;}) as ApiClient['request'];
 render(<App client={client(request)} initialEntries={['/channels/'+id]}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Gerar QR Code'}));
 expect(await screen.findByText('QR ou código expirado. Gere outro para continuar.')).toBeVisible();
 expect(screen.queryByRole('img',{name:'QR Code para conectar o WhatsApp'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Gerar QR Code'})).toBeEnabled();
});

it('renders a BASE64 pairing challenge as an image data URL',async()=>{
 const channel={schemaVersion:1,id,organizationId:org,provider:'QR',identity:{displayName:'Parear',maskedAddress:null},providerReference:{providerAccountId:account,instanceId:id},transportStatus:'DISCONNECTED',providerStatus:'READY',automationStatus:'UNBOUND',humanStatus:'UNBOUND',revision:1,createdAt:timestamp,updatedAt:timestamp};
 const request=vi.fn(async(path:string)=>{if(path.endsWith('/pair'))return {provider:'QR',channel,operationId:null,replayed:false,pending:false,reconciliationRequired:false,action:{type:'QR_CODE',encoding:'BASE64',value:'aGVsbG8=',expiresAt:new Date(Date.now()+60000).toISOString()}};if(path.endsWith('/automation'))return {binding:null};if(path==='/v1/automations')return {data:[]};return channel;}) as ApiClient['request'];
 render(<App client={client(request)} initialEntries={['/channels/'+id]}/>);fireEvent.click(await screen.findByRole('button',{name:'Gerar QR Code'}));expect(await screen.findByRole('img',{name:'QR Code para conectar o WhatsApp'})).toHaveAttribute('src','data:image/png;base64,aGVsbG8=');
});
