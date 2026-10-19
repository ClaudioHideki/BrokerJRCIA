// @vitest-environment jsdom
import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {ApiClient} from '../api/client.js';
import {HistoryImportPanel} from './HistoryImportPanel.js';
const org='10000000-0000-4000-8000-000000000001',channel='10000000-0000-4000-8000-000000000002',id='10000000-0000-4000-8000-000000000003';
const cap={schemaVersion:1,organizationId:org,channelId:channel,available:true,reason:null,maxRecords:1000};
const operation={schemaVersion:1,id,organizationId:org,channelId:channel,requestId:id,state:'OPEN',totalRecords:3,processedRecords:1,importedCount:1,duplicateCount:0,revision:1,from:'2026-01-01T00:00:00.000Z',to:'2026-01-02T00:00:00.000Z'};
const client=(request:unknown)=>({request,registerTenantPurge:()=>()=>{}} as unknown as ApiClient);
afterEach(()=>sessionStorage.clear());
it('shows the verified identity boundary and refuses an older cache range before POST',async()=>{
 const request=vi.fn(async()=>({...cap,availableFrom:'2026-01-02T10:20:30.000Z'}));
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 await screen.findByText(/Histórico verificável a partir de/);
 fireEvent.change(screen.getByLabelText('Início (UTC)'),{target:{value:'2026-01-01T00:00'}});
 fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-03T00:00'}});
 fireEvent.click(screen.getByRole('button',{name:'Iniciar importação'}));
 await screen.findByRole('alert');
 expect(request.mock.calls).toHaveLength(1);
});
it('updates progress automatically when background work finishes, without another click',async()=>{
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});let completed=false;
 sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({operationId:id,requestId:id}));
 const request=vi.fn(async(path:string)=>path.endsWith('/capability')?cap:completed?{...operation,state:'COMPLETED',processedRecords:3,importedCount:3,revision:2}:operation);
 try{render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
  await screen.findByText('Processados: 1 de 3');completed=true;
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(screen.getByText('Importação concluída.')).toBeInTheDocument();expect(screen.getByText('Processados: 3 de 3')).toBeInTheDocument();
  expect(screen.getByText('As mensagens foram gravadas no Broker. Confira o espelhamento na fila de integração da central.')).toBeInTheDocument();
 }finally{vi.useRealTimers();}
});
it('honestly disables import when no source is configured',async()=>{
 render(<HistoryImportPanel client={client(vi.fn(async()=>({...cap,available:false,reason:'SOURCE_NOT_CONFIGURED',maxRecords:0})))} organizationId={org} channelId={channel}/>);
 await screen.findByText(/fonte de histórico não está configurada/i);
 expect(screen.queryByRole('button',{name:'Iniciar importação'})).toBeNull();
});
it('starts, advances a bounded page and cancels without claiming completion',async()=>{
 const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/capability'))return cap;
  if(path.endsWith('/advance'))return {...operation,processedRecords:2,importedCount:2,revision:2,requestId:requestKey};
  if(path.endsWith('/cancel'))return {...operation,state:'CANCELED',processedRecords:2,importedCount:2,revision:3,requestId:requestKey};
  requestKey=new Headers(init?.headers).get('idempotency-key')!;return {...operation,requestId:requestKey};
 });let requestKey='';
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 fireEvent.change(await screen.findByLabelText('Início (UTC)'),{target:{value:'2026-01-01T00:00'}});
 fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-02T00:00'}});
 fireEvent.click(screen.getByRole('button',{name:'Iniciar importação'}));
 await screen.findByText('Processados: 1 de 3');
 expect(screen.queryByText('Importação concluída.')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Processar próxima página'}));await screen.findByText('Processados: 2 de 3');
 fireEvent.click(screen.getByRole('button',{name:'Cancelar importação'}));await screen.findByText(/Importação cancelada/);
});
it('aborts and discards late capability after a tenant change',async()=>{
 let release:(value:unknown)=>void=()=>{};let signal:AbortSignal|undefined;
 const old=client(vi.fn((_path:string,init?:RequestInit)=>{signal=init?.signal??undefined;return new Promise(r=>{release=r;});}));
 const next=client(vi.fn(async()=>({...cap,organizationId:id,available:false,reason:'SOURCE_NOT_CONFIGURED'})));
 const view=render(<HistoryImportPanel client={old} organizationId={org} channelId={channel}/>);
 view.rerender(<HistoryImportPanel client={next} organizationId={id} channelId={channel}/>);
 await act(async()=>release(cap));await screen.findByText(/fonte de histórico não está configurada/i);
 expect(signal?.aborted).toBe(true);expect(screen.queryByRole('button',{name:'Iniciar importação'})).toBeNull();
});
it('rejects a capability from a different channel',async()=>{
 render(<HistoryImportPanel client={client(vi.fn(async()=>({...cap,channelId:id})))} organizationId={org} channelId={channel}/>);
 await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Iniciar importação'})).toBeNull();
});
it('recovers an uncertain start by request id without repeating POST',async()=>{
 let key='';const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/capability'))return cap;
  if(path.includes('/by-request/'))return {...operation,requestId:key};
  key=new Headers(init?.headers).get('idempotency-key')!;throw new TypeError('Synthetic disconnect');
 });render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 fireEvent.change(await screen.findByLabelText('Início (UTC)'),{target:{value:'2026-01-01T00:00'}});
 fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-02T00:00'}});
 fireEvent.click(screen.getByRole('button',{name:'Iniciar importação'}));await screen.findByText('Processados: 1 de 3');
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(request.mock.calls.some(([path])=>path.endsWith(`/by-request/${key}`))).toBe(true);
});
it('reloads a saved operation with scoped ids and rejects another operation',async()=>{
 sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({operationId:id,requestId:id}));
 const request=vi.fn(async(path:string)=>path.endsWith('/capability')?cap:{...operation,id:channel});
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 await screen.findByRole('alert');expect(screen.queryByText('Processados: 1 de 3')).toBeNull();
 expect(screen.queryByRole('button',{name:'Iniciar importação'})).toBeNull();
 expect(screen.getByRole('button',{name:'Retomar importação'})).toBeEnabled();
});
it('keeps source API failures honest and does not allow import',async()=>{
 render(<HistoryImportPanel client={client(vi.fn(async()=>{throw Object.assign(new Error('Unavailable'),{status:404});}))} organizationId={org} channelId={channel}/>);
 await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Iniciar importação'})).toBeNull();
});
it('hydrates only validated recovery ids and preserves a saved open operation',async()=>{
 sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({operationId:id,requestId:id}));
 const request=vi.fn(async(path:string)=>path.endsWith('/capability')?cap:operation);
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 await screen.findByText('Processados: 1 de 3');expect(screen.getByText(/Operação:/)).toHaveTextContent(id);
 expect(request.mock.calls.some(([path])=>path.endsWith(`/${id}`))).toBe(true);
});
it('preserves the same request and selection across an uncertain start and lookup 404',async()=>{
 const keys:string[]=[],bodies:string[]=[];let lookups=0;
 const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/capability'))return cap;
  if(path.includes('/by-request/')){lookups++;throw Object.assign(new Error('Not found yet'),{status:404});}
  keys.push(new Headers(init?.headers).get('idempotency-key')!);bodies.push(String(init?.body));
  if(keys.length===1)throw new TypeError('Synthetic disconnect');return {...operation,requestId:keys[0]};
 });render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 fireEvent.change(await screen.findByLabelText('Início (UTC)'),{target:{value:'2026-01-01T00:00'}});fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-02T00:00'}});
 fireEvent.click(screen.getByRole('button',{name:'Iniciar importação'}));await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button',{name:'Retomar importação'}));await screen.findByText('Processados: 1 de 3');
 expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(bodies[0]).toBe(bodies[1]);expect(lookups).toBe(2);
});
it('serializes double submits before creating a recovery request',async()=>{
 let resolve:(value:unknown)=>void=()=>{};let key='';const request=vi.fn(async(path:string,init?:RequestInit)=>{
  if(path.endsWith('/capability'))return cap;key=new Headers(init?.headers).get('idempotency-key')!;return new Promise(r=>{resolve=r;});
 });render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 const input=await screen.findByLabelText('Início (UTC)');fireEvent.change(input,{target:{value:'2026-01-01T00:00'}});fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-02T00:00'}});
 const form=input.closest('form')!;fireEvent.submit(form);fireEvent.submit(form);
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(JSON.parse(sessionStorage.getItem(`history-import:${org}:${channel}`)!).requestId).toBe(key);
 await act(async()=>resolve({...operation,requestId:key}));
});
it('shows definitive source errors and allows a corrected new selection',async()=>{
 const request=vi.fn(async(path:string)=>{if(path.endsWith('/capability'))return cap;throw Object.assign(new Error('Missing source'),{status:503,code:'HISTORY_SOURCE_NOT_CONFIGURED'});});
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 fireEvent.change(await screen.findByLabelText('Início (UTC)'),{target:{value:'2026-01-01T00:00'}});fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-02T00:00'}});fireEvent.click(screen.getByRole('button',{name:'Iniciar importação'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(/fonte de histórico não está configurada/i));
 expect(screen.getByRole('button',{name:'Iniciar importação'})).toBeEnabled();expect(request.mock.calls.filter(([path])=>path.includes('/by-request/'))).toHaveLength(0);
});
it('does not let a late hydration response reopen a newer completed revision',async()=>{
 sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({operationId:id,requestId:id}));
 let release:(value:unknown)=>void=()=>{};let reads=0;
 const request=vi.fn(async(path:string)=>{if(path.endsWith('/capability'))return cap;if(++reads===1)return new Promise(r=>{release=r;});return {...operation,state:'COMPLETED',totalRecords:3,processedRecords:3,importedCount:3,revision:3};});
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Retomar importação'}));await screen.findByText('Importação concluída.');
 await act(async()=>release(operation));expect(screen.getByText('Importação concluída.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Cancelar importação'})).toBeNull();
});
it('retains an uncertain recovery after a later retry is denied',async()=>{
 const key=id,selection={from:operation.from,to:operation.to,maxRecords:1000};sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({requestId:key,selection}));
 const request=vi.fn(async(path:string,init?:RequestInit)=>{if(path.endsWith('/capability'))return cap;if(init?.method==='POST')throw Object.assign(new Error('Denied'),{status:403});throw Object.assign(new Error('Not found yet'),{status:404});});
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Retomar importação'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(/não tem permissão/));
 expect(JSON.parse(sessionStorage.getItem(`history-import:${org}:${channel}`)!).requestId).toBe(key);expect(screen.queryByRole('button',{name:'Iniciar importação'})).toBeNull();
});
it('ignores malformed local recovery rather than using it as authority',async()=>{
 sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({operationId:'private-path',requestId:'invalid'}));
 const request=vi.fn(async()=>cap);render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 await screen.findByRole('button',{name:'Iniciar importação'});expect(request).toHaveBeenCalledTimes(1);
});
it('discards a late start result after switching companies',async()=>{
 let release:(value:unknown)=>void=()=>{};let requestId='';const request=vi.fn(async(path:string,init?:RequestInit)=>{if(path.endsWith('/capability'))return cap;requestId=new Headers(init?.headers).get('idempotency-key')!;return new Promise(r=>{release=r;});});
 const view=render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 fireEvent.change(await screen.findByLabelText('Início (UTC)'),{target:{value:'2026-01-01T00:00'}});fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-02T00:00'}});fireEvent.click(screen.getByRole('button',{name:'Iniciar importação'}));
 view.rerender(<HistoryImportPanel client={client(vi.fn(async()=>({...cap,organizationId:id,available:false,reason:'SOURCE_NOT_CONFIGURED'})))} organizationId={id} channelId={channel}/>);
 await act(async()=>release({...operation,requestId}));await screen.findByText(/fonte de histórico não está configurada/i);expect(screen.queryByText('Processados: 1 de 3')).toBeNull();expect(sessionStorage.getItem(`history-import:${id}:${channel}`)).toBeNull();
});
it('does not replace a new operation with a late previous recovery response',async()=>{
 sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({operationId:id,requestId:id}));let release:(value:unknown)=>void=()=>{};let reads=0;
 const request=vi.fn(async(path:string,init?:RequestInit)=>{if(path.endsWith('/capability'))return cap;if(init?.method==='POST')return {...operation,id:org,requestId:new Headers(init.headers).get('idempotency-key')!};if(++reads===1)return new Promise(r=>{release=r;});return {...operation,state:'COMPLETED',processedRecords:3,importedCount:3,revision:3};});
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Retomar importação'}));await screen.findByText('Importação concluída.');
 fireEvent.change(await screen.findByLabelText('Início (UTC)'),{target:{value:'2026-01-01T00:00'}});fireEvent.change(screen.getByLabelText('Fim (UTC)'),{target:{value:'2026-01-02T00:00'}});fireEvent.click(screen.getByRole('button',{name:'Iniciar importação'}));await screen.findByText('Processados: 1 de 3');
 await act(async()=>release({...operation,state:'COMPLETED',processedRecords:3,importedCount:3,revision:3}));
 expect(screen.getByText(/Operação:/)).toHaveTextContent(org);expect(screen.getByText('Importação em andamento.')).toBeInTheDocument();
});
it.each(['unavailable','loading','error','over-limit'])('does not retry a saved start while capability is %s',async(mode)=>{
 const selection={from:operation.from,to:operation.to,maxRecords:1000};sessionStorage.setItem(`history-import:${org}:${channel}`,JSON.stringify({requestId:id,selection}));
 const request=vi.fn(async(path:string,init?:RequestInit)=>{if(path.endsWith('/capability')){if(mode==='loading')return new Promise(()=>{});if(mode==='error')throw new Error('Synthetic capability failure');return mode==='over-limit'?{...cap,maxRecords:100}:{...cap,available:false,reason:'SOURCE_NOT_CONFIGURED',maxRecords:0};}if(init?.method==='POST')return {...operation,requestId:id};throw Object.assign(new Error('Not found yet'),{status:404});});
 render(<HistoryImportPanel client={client(request)} organizationId={org} channelId={channel}/>);
 await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Retomar importação'}));
 await waitFor(()=>expect(request.mock.calls.filter(([path])=>path.includes('/by-request/'))).toHaveLength(2));
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
 expect(JSON.parse(sessionStorage.getItem(`history-import:${org}:${channel}`)!).requestId).toBe(id);
});
