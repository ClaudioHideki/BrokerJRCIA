// @vitest-environment jsdom
import { act,fireEvent,render,screen } from '@testing-library/react';
import { expect,it,vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { HistorySyncPanel } from './HistorySyncPanel.js';
const org='10000000-0000-4000-8000-000000000001',channel='10000000-0000-4000-8000-000000000002',id='10000000-0000-4000-8000-000000000003';
const run={schemaVersion:2,id,organizationId:org,channelId:channel,instanceId:id,revision:1,state:'RUNNING',capture:'CAPTURING',persistence:'RUNNING',projection:'RUNNING',
  sourceTotalKnown:false,lastError:null,counts:{chats:2,capturedMessages:6,persistedMessages:6,duplicateMessages:0,projectedMessages:4,pendingMedia:2,verifiedMedia:4,unavailableMedia:0,blockedRecords:0}};
const progress={schemaVersion:2,organizationId:org,channelId:channel,run};
const client=(request:unknown)=>({request,registerTenantPurge:()=>()=>{}} as unknown as ApiClient);
it('separates capture, persistence, destination and media without a fake complete percentage',async()=>{
  const request=vi.fn(async(_path:string,_init?:RequestInit)=>progress);render(<HistorySyncPanel client={client(request)} organizationId={org} channelId={channel}/>);
  await screen.findByText('Capturando histórico disponível');
  expect(screen.getByText(/Total do WhatsApp ainda não confirmado/)).toBeInTheDocument();
  expect(screen.getByText('4 de 6 mensagens confirmadas na central')).toBeInTheDocument();
  expect(screen.getByText('2 arquivos pendentes')).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(request).toHaveBeenCalledWith(`/v1/channels/${channel}/history-sync/v2/progress`,expect.objectContaining({signal:expect.any(AbortSignal)}));
  fireEvent.click(screen.getByRole('button',{name:'Atualizar progresso'}));
  expect(request.mock.calls.every(([,init])=>!init || !(init as RequestInit).method || (init as RequestInit).method==='GET')).toBe(true);
});
it('rejects cross-channel responses and does not render details from the wrong tenant',async()=>{
  render(<HistorySyncPanel client={client(vi.fn(async()=>({...progress,channelId:id,run:{...run,channelId:id}})))} organizationId={org} channelId={channel}/>);
  await screen.findByRole('alert');expect(screen.queryByText('Capturando histórico disponível')).toBeNull();
});
it('does not retain old progress after tenant purge or accept an old in-flight response',async()=>{
  let release:(value:unknown)=>void=()=>{},purge=()=>{};
  const request=vi.fn(()=>new Promise(resolve=>{release=resolve;}));
  const api={request,registerTenantPurge:(fn:()=>void)=>{purge=fn;return ()=>{};}} as unknown as ApiClient;
  render(<HistorySyncPanel client={api} organizationId={org} channelId={channel}/>);
  await act(async()=>{purge();release(progress);});
  expect(screen.queryByText('Capturando histórico disponível')).toBeNull();
});
it('shows explicit empty state instead of admitting a new capture from a read',async()=>{
  render(<HistorySyncPanel client={client(vi.fn(async()=>({...progress,run:null})))} organizationId={org} channelId={channel}/>);
  await screen.findByText('Nenhuma sincronização admitida para esta caixa.');
  expect(screen.queryByRole('button',{name:/iniciar|reprocessar/iu})).toBeNull();
});
