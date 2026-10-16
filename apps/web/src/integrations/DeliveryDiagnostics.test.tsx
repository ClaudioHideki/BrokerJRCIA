// @vitest-environment jsdom
import {act,fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {DeliveryDiagnostics} from './DeliveryDiagnostics.js';

it('shows all historical failure totals without loading payloads or replaying jobs',async()=>{
 const request=vi.fn(async()=>({data:[{status:'FAILED',code:'GROUP_CENTRAL_SCOPE_CHANGED',total:47,
  firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'},
  {status:'UNKNOWN',code:'CHATWOOT_OUTCOME_UNKNOWN',total:2,firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'}]}));
 render(<DeliveryDiagnostics request={request}/>);
 expect(request).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await screen.findByText('47')).toBeVisible();
 expect(screen.getByText(/Confira se o grupo continua selecionado/)).toBeVisible();
 expect(screen.getByText(/Confira o resultado na central antes de reenviar/)).toBeVisible();
 expect(request).toHaveBeenCalledExactlyOnceWith('/jobs/summary');
 expect(screen.queryByRole('button',{name:/Reprocessar/})).not.toBeInTheDocument();
});

it('does not keep stale totals after a failed refresh',async()=>{
 const request=vi.fn().mockResolvedValueOnce({data:[]}).mockRejectedValueOnce(new Error('private error'));
 render(<DeliveryDiagnostics request={request}/>);
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await screen.findByText('Nenhuma entrega com falha ou resultado incerto.')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar o diagnóstico.');
 expect(screen.queryByText('Nenhuma entrega com falha ou resultado incerto.')).not.toBeInTheDocument();
 expect(screen.queryByText('private error')).not.toBeInTheDocument();
});

it('discards a late response after the company request context changes',async()=>{
 let finish!:(value:unknown)=>void;
 const previous=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
 const current=vi.fn(async()=>({data:[]}));
 const view=render(<DeliveryDiagnostics request={previous}/>);
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 view.rerender(<DeliveryDiagnostics request={current}/>);
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await screen.findByText('Nenhuma entrega com falha ou resultado incerto.')).toBeVisible();
 await act(async()=>{finish({data:[{status:'FAILED',code:'OTHER',total:12345,firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'}]});});
 expect(screen.queryByText('12345')).not.toBeInTheDocument();
});
