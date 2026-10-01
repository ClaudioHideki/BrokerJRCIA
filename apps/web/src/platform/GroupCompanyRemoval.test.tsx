// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GroupCompanyRemoval, GroupCompanyRemovalLookup } from './GroupCompanyRemoval.js';
import { ApiClientError } from '../api/client.js';
afterEach(cleanup);
it('recovers the report by operation code even when the group no longer exists',async()=>{
  const request=vi.fn(async()=>({...running,status:'COMPLETED',groupStage:'REMOVED',companies:[{...running.companies[0],name:null,status:'COMPLETED'}]}));
  render(<GroupCompanyRemovalLookup request={request} disabled={false}/>);
  fireEvent.change(screen.getByLabelText('Código da operação de exclusão'),{target:{value:operation}});
  fireEvent.click(screen.getByRole('button',{name:'Consultar operação de exclusão'}));
  expect(await screen.findByText('O grupo vazio também foi removido.')).toBeInTheDocument();
  expect(request).toHaveBeenCalledWith(`/group-company-removals/${operation}`);
  expect(screen.queryByText('GoPure')).not.toBeInTheDocument();
});
const group='11111111-1111-4111-8111-111111111111',a='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333';
const operation='44444444-4444-4444-8444-444444444444';
const preview={previewId:'55555555-5555-4555-8555-555555555555',previewRevision:'66666666-6666-4666-8666-666666666666',groupId:group,
  groupName:'Grupo sintético',groupRevision:3,expiresAt:'2099-01-01T00:00:00Z',companies:[a,b].map((id,index)=>({resourceId:id,
    resourceName:index?'Operadora':'GoPure',kind:'ORGANIZATION',canDelete:true,blockers:[],counts:{qrConnections:1,users:2},
    externalEffects:['Conta e conversas externas preservadas'],operationId:null,operationStatus:null}))};
const running={operationId:operation,groupId:group,status:'RUNNING',groupStage:'PENDING',errorCode:null,updatedAt:'2026-09-30T12:00:00Z',companies:[
  {id:a,name:'GoPure',operationId:a,status:'REQUESTED',errorCode:null}]};
function api(){return vi.fn<(path:string,method?:string,body?:unknown)=>Promise<unknown>>(async(path:string,method?:string)=>{
  if(method==='POST')return path.endsWith('preview')?preview:running;
  return path.includes('group-company-removals')?running:{data:[],nextCursor:null};
});}
async function inspect(request=api()){
  render(<GroupCompanyRemoval groupId={group} groupName="Grupo sintético" request={request} disabled={false}/>);
  fireEvent.change(screen.getByLabelText('Motivo da exclusão selecionada'),{target:{value:'Encerrar empresas sintéticas'}});
  fireEvent.click(screen.getByRole('button',{name:'Consultar impacto das empresas'}));
  await screen.findByLabelText('Selecionar GoPure'); return request;
}
it('starts with no selection and requires operator-written exact names without prefilled confirmations',async()=>{
  const request=await inspect();
  expect(screen.getByLabelText('Selecionar GoPure')).not.toBeChecked();
  expect(screen.getByRole('button',{name:'Excluir empresas selecionadas'})).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Selecionar GoPure'));
  expect(screen.getByLabelText('Digite GoPure')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Digite GoPure'),{target:{value:'GoPure'}});
  fireEvent.click(screen.getByRole('button',{name:'Excluir empresas selecionadas'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith(`/groups/${group}/company-removals`,'POST',expect.objectContaining({
    groupId:group,expectedRevision:3,previewId:preview.previewId,previewRevision:preview.previewRevision,selectedCompanyIds:[a],
    confirmation:{companies:[{id:a,typedName:'GoPure'}],removeGroupIfEmpty:false},reason:'Encerrar empresas sintéticas'})));
  expect(await screen.findByText(/Operação:/)).toHaveTextContent(operation);
});
it('recovers a persisted partial operation on reload and gives an actionable path for uncertain cleanup',async()=>{
  const request=vi.fn(async()=>({data:[{...running,status:'ACTION_REQUIRED',companies:[{...running.companies[0],status:'ACTION_REQUIRED',errorCode:'EVOLUTION_CLEANUP_UNVERIFIED'}]}],nextCursor:null}));
  render(<GroupCompanyRemoval groupId={group} groupName="Grupo sintético" request={request} disabled={false}/>);
  expect(await screen.findByText(/Operação:/)).toHaveTextContent(operation);
  expect(screen.getByRole('button',{name:'Conferir remoção externa de GoPure'})).toBeInTheDocument();
  expect(screen.getByText(/consulta não repete a exclusão/i)).toBeInTheDocument();
});
it('blocks a company with remote bot attachment and explains the authorized configuration path',async()=>{
  const request=api();request.mockImplementation(async(path,method)=>method==='POST'?{...preview,companies:[{...preview.companies[0],canDelete:false,blockers:['FLOW_REMOTE_BOT_ATTACHED']}]}:{data:[],nextCursor:null});
  await inspect(request);
  expect(screen.getByLabelText('Selecionar GoPure')).toBeDisabled();
  expect(screen.getByText(/JRC Flows.*Conexões.*desativar.*vínculo/i)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Excluir empresas selecionadas'})).toBeDisabled();
});
it('discards a definitively rejected stale preview and permits a new preview with blank confirmations',async()=>{
  const request=await inspect();
  fireEvent.click(screen.getByLabelText('Selecionar GoPure'));
  fireEvent.change(screen.getByLabelText('Digite GoPure'),{target:{value:'GoPure'}});
  request.mockRejectedValueOnce(new ApiClientError('Changed preview',409,undefined,'GROUP_REMOVAL_PREVIEW_CHANGED'));
  fireEvent.click(screen.getByRole('button',{name:'Excluir empresas selecionadas'}));
  await screen.findByRole('alert');
  expect(screen.getByRole('button',{name:'Consultar impacto das empresas'})).toBeEnabled();
  expect(screen.queryByLabelText('Digite GoPure')).not.toBeInTheDocument();
});
it('reuses the exact idempotent request after a lost response instead of constructing a second selection',async()=>{
  const request=await inspect();fireEvent.click(screen.getByLabelText('Selecionar GoPure'));
  fireEvent.change(screen.getByLabelText('Digite GoPure'),{target:{value:'GoPure'}});
  request.mockRejectedValueOnce(new Error('Network unavailable'));
  fireEvent.click(screen.getByRole('button',{name:'Excluir empresas selecionadas'}));
  await screen.findByRole('alert');expect(screen.getByLabelText('Selecionar GoPure')).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Verificar solicitação enviada'}));
  await screen.findByText(/Operação:/);
  const writes=request.mock.calls.filter(([path,method])=>path.endsWith('company-removals')&&method==='POST');
  expect(writes).toHaveLength(2);expect(writes[0]![2]).toEqual(writes[1]![2]);
});
