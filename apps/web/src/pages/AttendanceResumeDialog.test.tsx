// @vitest-environment jsdom
import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { AttendanceResumeDialog } from './AttendanceResumeDialog.js';
const id='81555d45-b1a2-4a3f-ab95-c1459b0df0d0';
const context={diagnostic:{allowed:false,reason:'HUMAN_CONTROL',controlRevision:8,cycle:1},ownerRevision:3,hasActiveSession:false,hasCompatibleCursor:false,menuNodes:[],operation:null};
it('explains the scope of resuming and keeps keyboard dismissal free from a resume mutation',async()=>{
 const request=vi.fn().mockResolvedValue(context),closed=vi.fn();
 render(<AttendanceResumeDialog conversationId={id} client={{request} as unknown as ApiClient} onConfirmed={vi.fn()} onClose={closed}/>);
 const dialog=screen.getByRole('dialog',{name:'Retomar bot'});expect(dialog).toHaveFocus();
 expect(await screen.findByText(/Somente a conversa selecionada/)).toBeVisible();
 expect(screen.getByText(/Vincular ou publicar um fluxo não retoma/)).toBeVisible();
 expect(screen.getByText('Continua a espera compatível pela próxima mensagem.')).toBeVisible();
 expect(screen.getByText('Volta ao menu escolhido da sessão atual.')).toBeVisible();
 expect(screen.getByText('Começa pela versão publicada, sem reproduzir mensagens antigas.')).toBeVisible();
 const newSession=screen.getByRole('radio',{name:'Nova sessão'}),close=screen.getByRole('button',{name:'Fechar'});
 newSession.focus();fireEvent.keyDown(newSession,{key:'Tab',shiftKey:true});expect(close).toHaveFocus();
 fireEvent.keyDown(close,{key:'Tab'});expect(newSession).toHaveFocus();
 fireEvent.keyDown(dialog,{key:'Escape'});expect(closed).toHaveBeenCalledOnce();
 expect(request).toHaveBeenCalledOnce();expect(screen.getByRole('button',{name:'Confirmar retomada'})).toBeDisabled();
});
it('requires an explicit new session for a legacy conversation and only confirms after APPLIED',async()=>{
  let applied=false;
  const request=vi.fn(async(path:string,init?:RequestInit)=>path.endsWith('/resume-context')?context:
    {id,conversationId:id,state:applied?'APPLIED':'PENDING',sessionId:applied?id:null,errorCode:null});
  const confirmed=vi.fn(),closed=vi.fn();
  render(<AttendanceResumeDialog conversationId={id} client={{request} as unknown as ApiClient} onConfirmed={confirmed} onClose={closed} pollIntervalMs={5}/>);
  await screen.findByText(/não possui uma sessão/i);
  expect(screen.getByRole('radio',{name:/Continuar/i})).toBeDisabled();
  fireEvent.click(screen.getByRole('radio',{name:/Nova sessão/i}));fireEvent.click(screen.getByRole('button',{name:'Confirmar retomada'}));
  await screen.findByText(/Retomada pendente/i);expect(confirmed).not.toHaveBeenCalled();
  const post=request.mock.calls.find(call=>call[1]?.method==='POST')!;
  expect(post[0]).toBe(`/v1/attendance/conversations/${id}/resume`);
  expect(JSON.parse(post[1]!.body as string)).toEqual({expectedControlRevision:8,expectedOwnerRevision:3,target:{kind:'NEW_SESSION'}});
  applied=true;await waitFor(()=>expect(confirmed).toHaveBeenCalledTimes(1));
});
it('keeps uncertain operations blocked and gives a next action instead of reporting bot active',async()=>{
  const request=vi.fn(async(path:string)=>path.endsWith('/resume-context')?context:{id,conversationId:id,state:'UNKNOWN',sessionId:null,errorCode:'ATTENDANCE_RESUME_REMOTE_RESULT_UNKNOWN'});
  const confirmed=vi.fn();render(<AttendanceResumeDialog conversationId={id} client={{request} as unknown as ApiClient} onConfirmed={confirmed} onClose={vi.fn()}/>);
  await screen.findByText(/não possui uma sessão/i);fireEvent.click(screen.getByRole('radio',{name:/Nova sessão/i}));fireEvent.click(screen.getByRole('button',{name:'Confirmar retomada'}));
  await screen.findByText(/resultado.*incerto/i);expect(confirmed).not.toHaveBeenCalled();
});
it('reuses the original request key after a lost acceptance response and aborts on close',async()=>{
  let lost=true;const posts:RequestInit[]=[];
  const request=vi.fn(async(path:string,init?:RequestInit)=>{
    if(path.endsWith('/resume-context'))return context;
    if(init?.method==='POST'){posts.push(init);if(lost){lost=false;throw new Error('response lost');}}
    return {id,conversationId:id,state:'PENDING',sessionId:null,errorCode:null};
  });
  const confirmed=vi.fn(),view=render(<AttendanceResumeDialog conversationId={id} client={{request} as unknown as ApiClient} onConfirmed={confirmed} onClose={vi.fn()} pollIntervalMs={10000}/>);
  await screen.findByText(/não possui uma sessão/i);fireEvent.click(screen.getByRole('radio',{name:/Nova sessão/i}));
  fireEvent.click(screen.getByRole('button',{name:'Confirmar retomada'}));await screen.findByText(/mesma escolha/i);
  fireEvent.click(screen.getByRole('button',{name:'Confirmar retomada'}));await screen.findByText(/Retomada pendente/i);
  expect(posts).toHaveLength(2);expect(posts[0]!.headers).toEqual(posts[1]!.headers);expect(posts[0]!.body).toBe(posts[1]!.body);
  expect(confirmed).not.toHaveBeenCalled();view.unmount();expect(posts[1]!.signal?.aborted).toBe(true);
});
