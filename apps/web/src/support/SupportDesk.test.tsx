// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SupportDesk } from './SupportDesk.js';
const ticket={id:'one',organizationId:'org',organizationName:'Empresa',title:'Conexão sem QR',status:'OPEN' as const,revision:1,assigneeId:null,createdAt:'2026-09-29T12:00:00Z',updatedAt:'2026-09-29T12:00:00Z',firstResponseAt:null,responseDueAt:'2026-09-30T12:00:00Z',resolvedAt:null};
const detail={ticket,messages:[{id:'first',authorKind:'TENANT' as const,kind:'REPLY' as const,body:'Não aparece o código QR.',createdAt:ticket.createdAt}],olderMessagesAvailable:false};
it('lets a company create and follow a ticket, retaining the request id on an uncertain retry',async()=>{
  let fail=true;
  const request=vi.fn(async(_path:string,method?:string)=>{if(method==='POST'){if(fail){fail=false;throw new Error('Falha temporária');}return detail;}return {data:[]};});
  render(<SupportDesk request={request as never} scopeKey="tenant-one" canWrite />);
  await screen.findByText('Nenhum chamado encontrado.');
  fireEvent.change(screen.getByLabelText('Assunto'),{target:{value:'Conexão sem QR'}});
  fireEvent.change(screen.getByLabelText('Descreva o problema'),{target:{value:'Não aparece o código QR.'}});
  fireEvent.click(screen.getByRole('button',{name:'Abrir chamado'})); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Abrir chamado'}));
  await screen.findByRole('heading',{name:'Conexão sem QR'});
  const calls=request.mock.calls.filter(call=>call[1]==='POST') as unknown as Array<[string,string,{requestId:string}]>;
  expect(calls).toHaveLength(2); expect(calls[0]![2].requestId).toBe(calls[1]![2].requestId);
});
it('gives the JRC team a received queue and assignment controls',async()=>{
  const request=vi.fn(async(path:string)=>path.endsWith('/one')?detail:{data:[ticket]});
  render(<SupportDesk request={request as never} scopeKey="staff-one" staff canWrite />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));
  await screen.findByRole('button',{name:'Assumir atendimento'});
  expect(screen.getByText('Não aparece o código QR.')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Abrir chamado'})).not.toBeInTheDocument();
});
it('offers read-only support history to viewers',async()=>{
  const request=vi.fn(async(path:string)=>path.endsWith('/one')?detail:{data:[ticket]});
  render(<SupportDesk request={request as never} scopeKey="reader-one" canWrite={false} />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));
  await waitFor(()=>expect(screen.getByText('Não aparece o código QR.')).toBeInTheDocument());
  expect(screen.queryByRole('button',{name:'Enviar resposta'})).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Assunto')).not.toBeInTheDocument();
});
