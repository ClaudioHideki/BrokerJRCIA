// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompanyDeletion } from './CompanyDeletion.js';

afterEach(cleanup);

const preview={resourceId:'00000000-0000-4000-8000-000000000001',resourceName:'Casa do Construtor',kind:'ORGANIZATION',
  canDelete:true,blockers:[],counts:{users:3,qrConnections:2,metaConnections:1},
  externalEffects:['Sessões Evolution removidas; Chatwoot externo preservado'],operationId:null,operationStatus:null};

it('requires exact company name and reason, then waits for persisted completion',async()=>{
  const onDeleted=vi.fn();
  const request=vi.fn(async(path:string,method?:string)=>{
    if(path==='/deletion-preview')return preview;
    if(path==='/deletion'&&method==='POST')return {operationId:'00000000-0000-4000-8000-000000000009',status:'REQUESTED'};
    return {operationId:'00000000-0000-4000-8000-000000000009',status:'COMPLETED',errorCode:null,updatedAt:new Date().toISOString()};
  });
  render(<CompanyDeletion companyName="Casa do Construtor" request={request} onDeleted={onDeleted}/>);
  expect(await screen.findByText(/3 usuários/)).toBeVisible();
  expect(screen.getByText(/Chatwoot externo preservado/)).toBeVisible();
  const button=screen.getByRole('button',{name:'Excluir empresa definitivamente'});
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Digite o nome da empresa'),{target:{value:'Casa do Construtor'}});
  fireEvent.change(screen.getByLabelText('Motivo da exclusão'),{target:{value:'Solicitação do titular'}});
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(()=>expect(request).toHaveBeenCalledWith('/deletion','POST',{
    confirmationName:'Casa do Construtor',reason:'Solicitação do titular',
  }));
  await waitFor(()=>expect(onDeleted).toHaveBeenCalledTimes(1));
});

it('does not report success when cleanup requires attention',async()=>{
  const onDeleted=vi.fn();
  const request=vi.fn(async(path:string)=>path==='/deletion-preview'
    ? {...preview,operationId:'00000000-0000-4000-8000-000000000009',operationStatus:'ACTION_REQUIRED'}
    : {operationId:'00000000-0000-4000-8000-000000000009',status:'ACTION_REQUIRED',
      errorCode:'EVOLUTION_CLEANUP_UNVERIFIED',updatedAt:new Date().toISOString()});
  render(<CompanyDeletion companyName="Casa do Construtor" request={request} onDeleted={onDeleted}/>);
  expect(await screen.findByText(/remoção no Evolution não foi confirmada/i)).toBeVisible();
  expect(onDeleted).not.toHaveBeenCalled();
});

it('rejects a malformed preview without breaking the administrator page',async()=>{
  const onDeleted=vi.fn(),request=vi.fn(async()=>({}));
  render(<CompanyDeletion companyName="Casa do Construtor" request={request} onDeleted={onDeleted}/>);
  expect(await screen.findByText(/Não foi possível validar o impacto/)).toBeVisible();
  expect(screen.getByRole('button',{name:'Excluir empresa definitivamente'})).toBeDisabled();
  expect(onDeleted).not.toHaveBeenCalled();
});
