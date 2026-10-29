// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { App } from '../app/App.js';

afterEach(()=>Object.defineProperty(window,'innerWidth',{configurable:true,value:1024}));

function fixture(role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'OWNER') {
  const org = {id:'92776cb0-bcba-45c0-98a3-2937fefdfdaf', name:'Empresa sintética',slug:'synthetic',role};
  return {
    restore: vi.fn(async () => ({user:{id:'8e757fb4-18ff-4c20-841b-19f282ece546',email:'user@example.test'},activeOrganization:org,organizations:[org]})),
    request: vi.fn(async () => ({status:'ACTIVE',maxInstances:3,maxUsers:10,messagesPerDay:100,maxPendingMessages:20,messagesAcceptedToday:0})),
    registerTenantPurge: () => () => undefined,
    subscribeToSessionExpiration: () => () => undefined,
  } as unknown as ApiClient;
}

it('agrupa os destinos reais e distingue configurações dos limites da empresa', async () => {
  render(<App client={fixture()} initialEntries={['/minha-empresa']} />);
  await screen.findByRole('heading',{name:'Minha empresa'});
  const nav = screen.getByRole('navigation',{name:'Navegação principal'});
  expect(within(nav).getByRole('button',{name:'Seção Configurações'})).toHaveAttribute('aria-expanded','true');
  expect(within(nav).getByRole('link',{name:'Configurações'})).toHaveAttribute('href','/configuracoes');
  expect(within(nav).getByRole('link',{name:'Minha empresa e limites'})).toHaveAttribute('href','/minha-empresa');
  expect(within(nav).getByRole('link',{name:'API e webhooks'})).toHaveAttribute('href','/api-webhooks');
});

it.each(['OPERATOR','VIEWER'] as const)('%s mantém leitura permitida sem atalho de gestão de chaves', async role => {
  render(<App client={fixture(role)} initialEntries={['/minha-empresa']} />);
  await screen.findByRole('heading',{name:'Minha empresa'});
  const nav = screen.getByRole('navigation',{name:'Navegação principal'});
  expect(within(nav).queryByRole('link',{name:'Chaves de API'})).not.toBeInTheDocument();
  expect(within(nav).getByRole('link',{name:'Credenciais'})).toHaveAttribute('href','/credentials');
  expect(within(nav).getByRole('link',{name:'Integrações'})).toHaveAttribute('href','/integracoes');
  expect(within(nav).getByRole('link',{name:'Flows e automações'})).toHaveAttribute('href','/automations');
});

it('pesquisa páginas por sinônimo sem acentos e informa ausência de resultados', async () => {
  render(<App client={fixture()} initialEntries={['/minha-empresa']} />);
  await screen.findByRole('heading',{name:'Minha empresa'});
  const search = screen.getByRole('searchbox',{name:'Buscar páginas e configurações'});
  fireEvent.change(search,{target:{value:'saude'}});
  const nav = screen.getByRole('navigation',{name:'Navegação principal'});
  expect(within(nav).getByRole('link',{name:'Saúde operacional'})).toHaveAttribute('href','/operations/health');
  expect(within(nav).queryByRole('link',{name:'Chaves de API'})).not.toBeInTheDocument();
  fireEvent.change(search,{target:{value:'inexistente'}});
  expect(within(nav).getByRole('status')).toHaveTextContent('Nenhuma página encontrada');
  fireEvent.click(screen.getByRole('button',{name:'Limpar busca de páginas'}));
  expect(within(nav).getByRole('link',{name:'Chaves de API'})).toBeVisible();
});

it('recolhe uma seção mantendo seus rótulos descobríveis e restaura os links', async () => {
  render(<App client={fixture()} initialEntries={['/minha-empresa']} />);
  await screen.findByRole('heading',{name:'Minha empresa'});
  const nav = screen.getByRole('navigation',{name:'Navegação principal'});
  const toggle=within(nav).getByRole('button',{name:'Seção API e webhooks'});
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded','false');
  expect(within(nav).queryByRole('link',{name:'Chaves de API'})).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(within(nav).getByRole('link',{name:'Chaves de API'})).toBeVisible();
});

it('preserva deep link restrito com orientação sem consultar chaves', async () => {
  const api=fixture('VIEWER');
  render(<App client={api} initialEntries={['/chaves-api']} />);
  expect(await screen.findByRole('heading',{name:'Acesso restrito'})).toBeVisible();
  expect(api.request).not.toHaveBeenCalled();
});

it('ao reabrir no mobile foca o primeiro destino visível quando a primeira seção foi recolhida', async () => {
  Object.defineProperty(window,'innerWidth',{configurable:true,value:390});
  render(<App client={fixture()} initialEntries={['/minha-empresa']} />);
  await screen.findByRole('heading',{name:'Minha empresa'});
  fireEvent.click(screen.getByRole('button',{name:'Abrir navegação'}));
  fireEvent.click(screen.getByRole('button',{name:'Seção Visão geral'}));
  fireEvent.keyDown(document,{key:'Escape'});
  fireEvent.click(screen.getByRole('button',{name:'Abrir navegação'}));
  await waitFor(()=>expect(screen.getByRole('link',{name:'Conexões e caixas'})).toHaveFocus());
});

it('busca sem resultados mantém foco acessível ao reabrir e ao limpar', async () => {
  Object.defineProperty(window,'innerWidth',{configurable:true,value:390});
  render(<App client={fixture()} initialEntries={['/minha-empresa']} />);
  await screen.findByRole('heading',{name:'Minha empresa'});
  fireEvent.click(screen.getByRole('button',{name:'Abrir navegação'}));
  fireEvent.change(screen.getByRole('searchbox',{name:'Buscar páginas e configurações'}),{target:{value:'inexistente'}});
  fireEvent.keyDown(document,{key:'Escape'});
  fireEvent.click(screen.getByRole('button',{name:'Abrir navegação'}));
  await waitFor(()=>expect(screen.getByRole('searchbox',{name:'Buscar páginas e configurações'})).toHaveFocus());
  fireEvent.click(screen.getByRole('button',{name:'Limpar busca de páginas'}));
  expect(screen.getByRole('searchbox',{name:'Buscar páginas e configurações'})).toHaveFocus();
});
