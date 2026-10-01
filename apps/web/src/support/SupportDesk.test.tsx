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
it('keeps a typed reply while refreshing after another operator updates the ticket',async()=>{
  const revised={...detail,ticket:{...ticket,revision:2,status:'IN_PROGRESS' as const}};
  let reads=0;
  const request=vi.fn(async(path:string)=>path.endsWith('/one')?(++reads===1?detail:revised):{data:[ticket]});
  render(<SupportDesk request={request as never} scopeKey="staff-reconnect" staff canWrite />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));
  await screen.findByText('Não aparece o código QR.');
  fireEvent.change(screen.getByLabelText('Resposta'),{target:{value:'Minha resposta ainda não enviada'}});
  fireEvent.click(screen.getByRole('button',{name:'Atualizar histórico'}));
  await waitFor(()=>expect(screen.getByLabelText('Resposta')).toHaveValue('Minha resposta ainda não enviada'));
  expect(screen.getByRole('combobox',{name:'Situação'})).toHaveValue('IN_PROGRESS');
  expect(screen.getByRole('status')).toHaveTextContent('O chamado recebeu uma atualização');
});
it('filters the staff queue and distinguishes an overdue first response',async()=>{
  const overdue={...ticket,firstResponseState:'OVERDUE',responseDueAt:'2026-09-28T12:00:00Z'};
  const request=vi.fn(async(path:string)=>path.endsWith('/one')?{...detail,ticket:overdue}:{data:[overdue]});
  render(<SupportDesk request={request as never} scopeKey="staff-filter" staff canWrite />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));
  await screen.findByText(/Primeira resposta vencida/);
  fireEvent.change(screen.getByLabelText('Filtrar situação'),{target:{value:'OPEN'}});
  await waitFor(()=>expect(request.mock.calls.some(([path])=>path.includes('status=OPEN'))).toBe(true));
});
it('refreshes the open ticket after reconnect without replacing an unsent reply',async()=>{
  const revised={...detail,ticket:{...ticket,revision:2,status:'IN_PROGRESS' as const}};
  let reads=0;
  const request=vi.fn(async(path:string)=>path.endsWith('/one')?(++reads===1?detail:revised):{data:[ticket]});
  render(<SupportDesk request={request as never} scopeKey="reconnect" staff canWrite />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));
  await screen.findByText('Não aparece o código QR.');
  fireEvent.change(screen.getByLabelText('Resposta'),{target:{value:'Rascunho após desconexão'}});
  fireEvent(window,new Event('online'));
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'Situação'})).toHaveValue('IN_PROGRESS'));
  expect(screen.getByLabelText('Resposta')).toHaveValue('Rascunho após desconexão');
});
it('keeps an unsent reply when refreshing the same ticket fails and is retried',async()=>{
  let reads=0;
  const request=vi.fn(async(path:string)=>{if(!path.endsWith('/one'))return {data:[ticket]};if(++reads===2)throw new Error('Temporarily offline');return detail;});
  render(<SupportDesk request={request as never} scopeKey="retry-refresh" staff canWrite />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));
  await screen.findByText('Não aparece o código QR.');
  fireEvent.change(screen.getByLabelText('Resposta'),{target:{value:'Rascunho preservado'}});
  fireEvent.click(screen.getByRole('button',{name:'Atualizar histórico'}));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Atualizar histórico'}));
  await waitFor(()=>expect(screen.getByLabelText('Resposta')).toHaveValue('Rascunho preservado'));
});
it('releases the busy state when staff changes a filter during a pending reply',async()=>{
  let finish:((value:unknown)=>void)|undefined;
  const request=vi.fn(async(path:string,method?:string)=>method==='POST'?new Promise(resolve=>{finish=resolve;}):path.endsWith('/one')?detail:{data:[ticket]});
  render(<SupportDesk request={request as never} scopeKey="filter-pending" staff canWrite />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));await screen.findByText('Não aparece o código QR.');
  fireEvent.change(screen.getByLabelText('Resposta'),{target:{value:'Resposta em andamento'}});
  fireEvent.click(screen.getByRole('button',{name:'Enviar resposta'}));
  await waitFor(()=>expect(finish).toBeDefined());
  fireEvent.change(screen.getByLabelText('Filtrar situação'),{target:{value:'OPEN'}});
  finish!(detail);
  await waitFor(()=>expect(screen.getByRole('region',{name:'Histórico do chamado'}).closest('.support-desk')).toHaveAttribute('aria-busy','false'));
});
it.each(['GET before POST','GET after POST'] as const)('keeps the committed reply when a reconnect %s finishes last',async order=>{
  const committed={...detail,ticket:{...ticket,revision:2,status:'WAITING_CUSTOMER' as const},messages:[...detail.messages,{id:'staff-reply',authorKind:'PLATFORM' as const,kind:'REPLY' as const,body:'Enviada.',createdAt:ticket.createdAt}]};
  let reads=0,finishGet:((value:unknown)=>void)|undefined,finishPost:((value:unknown)=>void)|undefined;
  const request=vi.fn(async(path:string,method?:string)=>{
    if(method==='POST')return new Promise(resolve=>{finishPost=resolve;});
    if(path.endsWith('/one'))return ++reads===1?detail:new Promise(resolve=>{finishGet=resolve;});
    return {data:[ticket]};
  });
  render(<SupportDesk request={request as never} scopeKey={`order-${order}`} staff canWrite />);
  fireEvent.click(await screen.findByRole('button',{name:/Conexão sem QR/}));await screen.findByText('Não aparece o código QR.');
  fireEvent.change(screen.getByLabelText('Resposta'),{target:{value:'Enviada.'}});
  const submit=()=>fireEvent.submit(screen.getByLabelText('Resposta').closest('form')!);
  if(order==='GET before POST'){fireEvent(window,new Event('online'));await waitFor(()=>expect(finishGet).toBeDefined());submit();}
  else{submit();await waitFor(()=>expect(finishPost).toBeDefined());fireEvent(window,new Event('online'));}
  await waitFor(()=>expect(finishPost).toBeDefined());await waitFor(()=>expect(finishGet).toBeDefined());
  finishPost!(committed);
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'Situação'})).toHaveValue('WAITING_CUSTOMER'));
  finishGet!(detail);
  await waitFor(()=>expect(screen.getByRole('region',{name:'Histórico do chamado'}).closest('.support-desk')).toHaveAttribute('aria-busy','false'));
  expect(screen.getByRole('combobox',{name:'Situação'})).toHaveValue('WAITING_CUSTOMER');
  expect(screen.getByText('Enviada.')).toBeInTheDocument();
});
