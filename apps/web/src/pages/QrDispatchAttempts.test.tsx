// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import type {ApiClient} from '../api/client.js';
import {QrDispatchAttempts} from './QrDispatchAttempts.js';
const id='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',pending={id,messageId:id,revision:2,state:'UNKNOWN'};
it('mostra tentativa incerta sem eco e abandona por revisão sem inventar envio',async()=>{
 const calls:unknown[]=[],changed=vi.fn();let abandoned=false;
 const client={request:vi.fn(async(_path:string,init?:RequestInit)=>{if(init?.method==='POST'){calls.push(JSON.parse(String(init.body)));abandoned=true;return {...pending,revision:3,state:'ABANDONED'};}return {data:abandoned?[]:[pending]};})} as unknown as ApiClient;
 render(<QrDispatchAttempts client={client} conversationId={id} canAbandon onChanged={changed}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Abandonar tentativa sem reenvio'}));
 fireEvent.change(screen.getByLabelText('Motivo do abandono da tentativa'),{target:{value:'Sem eco, abandono sem reenviar'}});
 const confirm=screen.getByRole('button',{name:'Confirmar abandono da tentativa'}) as HTMLButtonElement;
 expect(confirm.disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(confirm);
 await waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
 expect(calls).toEqual([{expectedRevision:2,reason:'Sem eco, abandono sem reenviar'}]);
});
it('expõe resultado incerto ao operador sem conceder abandono',async()=>{
 const client={request:vi.fn(async()=>({data:[pending]}))} as unknown as ApiClient;
 render(<QrDispatchAttempts client={client} conversationId={id} canAbandon={false} onChanged={()=>{}}/>);
 await screen.findByText(/O resultado continua incerto, mesmo sem eco recebido/);
 expect(screen.queryByRole('button',{name:'Abandonar tentativa sem reenvio'})).toBeNull();
});
it('preserva POST pendente e atualiza após commit quando o histórico é recarregado',async()=>{
 const onChanged=vi.fn();let abandoned=false,reads=0,mutations=0,postSignal:AbortSignal|null|undefined;
 let completePost!:(value:unknown)=>void;
 const post=new Promise<unknown>(resolve=>{completePost=resolve;});
 const client={request:vi.fn(async(_path:string,init?:RequestInit)=>{
  if(init?.method==='POST'){mutations++;postSignal=init.signal;return post;}
  reads++;return {data:abandoned?[]:[pending]};
 })} as unknown as ApiClient;
 const view=render(<QrDispatchAttempts client={client} conversationId={id} canAbandon onChanged={onChanged} refreshRevision={0}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Abandonar tentativa sem reenvio'}));
 fireEvent.change(screen.getByLabelText('Motivo do abandono da tentativa'),{target:{value:'Sem eco, abandono sem reenviar'}});
 fireEvent.click(screen.getByRole('checkbox'));
 fireEvent.click(screen.getByRole('button',{name:'Confirmar abandono da tentativa'}));
 await waitFor(()=>expect(mutations).toBe(1));
 view.rerender(<QrDispatchAttempts client={client} conversationId={id} canAbandon onChanged={onChanged} refreshRevision={1}/>);
 await waitFor(()=>expect(reads).toBe(2));
 expect(postSignal?.aborted).toBe(false);
 expect((screen.getByLabelText('Motivo do abandono da tentativa') as HTMLTextAreaElement).disabled).toBe(true);
 expect((screen.getByRole('button',{name:'Confirmar abandono da tentativa'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Confirmar abandono da tentativa'}));
 expect(mutations).toBe(1);
 await act(async()=>{abandoned=true;completePost({...pending,revision:3,state:'ABANDONED'});});
 await waitFor(()=>expect(onChanged).toHaveBeenCalledTimes(1));
 await waitFor(()=>expect(screen.queryByText(/O resultado continua incerto, mesmo sem eco recebido/)).toBeNull());
 expect(reads).toBe(3);
 expect((screen.getByRole('button',{name:'Atualizar tentativas de envio'}) as HTMLButtonElement).disabled).toBe(false);
});
