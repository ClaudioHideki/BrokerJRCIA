// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {ApiClient} from '../api/client.js';
import {QrOutboundObservations} from './QrOutboundObservations.js';
const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',attempt='bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const pending={id,revision:3,blocking:true,disposition:'RECONCILE',reason:'QR_ACK_PENDING',attempts:[{id:attempt,messageId:attempt,state:'UNKNOWN'}]};
it('exige reconhecimento explícito e envia revisão e tentativas atuais sem reenvio',async()=>{
  const mutations:unknown[]=[],onChanged=vi.fn();let abandoned=false;
  const client={request:vi.fn(async(_path:string,init?:RequestInit)=>{
    if(init?.method==='POST'){mutations.push(JSON.parse(String(init.body)));abandoned=true;return {...pending,revision:4,blocking:false,disposition:'ABANDONED',reason:'QR_OBSERVATION_ABANDONED',attempts:[]};}
    return {data:abandoned?[]:[pending]};
  })} as unknown as ApiClient;
  render(<QrOutboundObservations client={client} conversationId={id} canAbandon onChanged={onChanged}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Abandonar reconciliação sem reenvio'}));
  const confirm=screen.getByRole('button',{name:'Confirmar abandono sem reenvio'}) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText('Motivo do abandono'),{target:{value:'Sem prova atual, abandono sem reenviar'}});
  expect(confirm.disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(confirm);
  await waitFor(()=>expect(onChanged).toHaveBeenCalledTimes(1));
  expect(mutations).toEqual([{expectedRevision:3,attemptIds:[attempt],reason:'Sem prova atual, abandono sem reenviar'}]);
});
it('mostra a pendência ao operador mas reserva o abandono ao administrador',async()=>{
  const client={request:vi.fn(async()=>({data:[pending]}))} as unknown as ApiClient;
  render(<QrOutboundObservations client={client} conversationId={id} canAbandon={false} onChanged={()=>{}}/>);
  await screen.findByText('Novas ações nesta conversa aguardam a reconciliação.');
  expect(screen.queryByRole('button',{name:'Abandonar reconciliação sem reenvio'})).toBeNull();
});
it('não oferece abandono de uma tentativa ainda despachada',async()=>{
  const client={request:vi.fn(async()=>({data:[{...pending,attempts:[{...pending.attempts[0],state:'DISPATCHED'}]}]}))} as unknown as ApiClient;
  render(<QrOutboundObservations client={client} conversationId={id} canAbandon onChanged={()=>{}}/>);
  expect((await screen.findByRole('button',{name:'Abandonar reconciliação sem reenvio'}) as HTMLButtonElement).disabled).toBe(true);
});
it('explica observação factual impedida pela exclusão sem declarar entrega nem bloquear drenagem',async()=>{
  const client={request:vi.fn(async()=>({data:[{...pending,blocking:false,reason:'QR_LIFECYCLE_RECONCILE',attempts:[]}]}))} as unknown as ApiClient;
  render(<QrOutboundObservations client={client} conversationId={id} canAbandon={false} onChanged={()=>{}}/>);
  await screen.findByText('A saída anterior ficou sem materialização após iniciar a exclusão. Ela não bloqueia a drenagem e não será reenviada.');
  expect(screen.queryByText('Novas ações nesta conversa aguardam a reconciliação.')).toBeNull();
  expect(screen.queryByText(/Uma tentativa de envio do Broker ainda não tem confirmação/)).toBeNull();
});
it('preserva POST pendente e atualiza após commit quando o histórico é recarregado',async()=>{
  const onChanged=vi.fn();let abandoned=false,reads=0,mutations=0,postSignal:AbortSignal|null|undefined;
  let completePost!:(value:unknown)=>void;
  const post=new Promise<unknown>(resolve=>{completePost=resolve;});
  const client={request:vi.fn(async(_path:string,init?:RequestInit)=>{
    if(init?.method==='POST'){mutations++;postSignal=init.signal;return post;}
    reads++;return {data:abandoned?[]:[pending]};
  })} as unknown as ApiClient;
  const view=render(<QrOutboundObservations client={client} conversationId={id} canAbandon onChanged={onChanged} refreshRevision={0}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Abandonar reconciliação sem reenvio'}));
  fireEvent.change(screen.getByLabelText('Motivo do abandono'),{target:{value:'Sem prova atual, abandono sem reenviar'}});
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'Confirmar abandono sem reenvio'}));
  await waitFor(()=>expect(mutations).toBe(1));
  view.rerender(<QrOutboundObservations client={client} conversationId={id} canAbandon onChanged={onChanged} refreshRevision={1}/>);
  await waitFor(()=>expect(reads).toBe(2));
  expect(postSignal?.aborted).toBe(false);
  expect((screen.getByLabelText('Motivo do abandono') as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByRole('button',{name:'Confirmar abandono sem reenvio'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Confirmar abandono sem reenvio'}));
  expect(mutations).toBe(1);
  await act(async()=>{abandoned=true;completePost({...pending,revision:4,blocking:false,disposition:'ABANDONED',reason:'QR_OBSERVATION_ABANDONED',attempts:[]});});
  await waitFor(()=>expect(onChanged).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(screen.queryByText('Novas ações nesta conversa aguardam a reconciliação.')).toBeNull());
  expect(reads).toBe(3);
  expect((screen.getByRole('button',{name:'Atualizar reconciliação'}) as HTMLButtonElement).disabled).toBe(false);
});
