// @vitest-environment jsdom
import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {DeliveryDiagnostics} from './DeliveryDiagnostics.js';

it('shows all historical failure totals without loading payloads or replaying jobs',async()=>{
 const request=vi.fn(async()=>({data:[{status:'FAILED',code:'GROUP_CENTRAL_SCOPE_CHANGED',total:47,
  firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'},
  {status:'UNKNOWN',code:'CHATWOOT_OUTCOME_UNKNOWN',total:2,firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'}]}));
 render(<DeliveryDiagnostics request={request}/>);
 expect(request).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await screen.findByText('47 tarefas')).toBeVisible();
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

it('explains denied diagnostic access without presenting unknown totals as zero',async()=>{
 const {ApiClientError}=await import('../api/client.js');
 const request=vi.fn().mockRejectedValue(new ApiClientError('Forbidden',403,'synthetic-trace'));
 render(<DeliveryDiagnostics request={request}/>);
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Seu acesso não permite consultar o diagnóstico das entregas.');
 expect(screen.getByRole('alert')).toHaveTextContent('synthetic-trace');
 expect(screen.queryByText('Nenhuma entrega com falha ou resultado incerto.')).not.toBeInTheDocument();
});

it('keeps the query control focusable while loading and prevents duplicate requests',async()=>{
 let finish!:(value:unknown)=>void;
 const request=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
 render(<DeliveryDiagnostics request={request}/>);
 const query=screen.getByRole('button',{name:'Diagnóstico de todas as entregas'});query.focus();
 fireEvent.click(query);
 expect(query).toHaveAttribute('aria-disabled','true');expect(query).not.toBeDisabled();expect(query).toHaveFocus();
 fireEvent.click(query);expect(request).toHaveBeenCalledTimes(1);
 await act(async()=>finish({data:[]}));
 expect(query).toHaveAttribute('aria-disabled','false');expect(query).toHaveFocus();
});

it.each([
 ['CHATWOOT_HISTORY_UNSUPPORTED','Esta central não oferece importação de histórico neste caminho. As mensagens novas devem ser verificadas separadamente.','Importação de histórico não suportada'],
 ['CHATWOOT_HISTORY_UNAVAILABLE','Confira a disponibilidade da importação histórica na central. Preserve as tarefas pendentes e a mesma identificação da mensagem ao retomar; não envie o histórico como mensagens novas ao cliente.','Importação de histórico indisponível na central'],
])('explains %s instead of leaving the next action blank',async(code,advice,title)=>{
 const request=vi.fn(async()=>({data:[{status:'FAILED',code,total:3,
  firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'}]}));
 render(<DeliveryDiagnostics request={request}/>);
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await screen.findByRole('heading',{name:title})).toBeVisible();
 expect(screen.getByText(advice)).toBeVisible();
});

it('presents readable issue records with creation dates and source, without implying current delivery health',async()=>{
 const request=vi.fn(async()=>({data:[{status:'UNKNOWN',code:'CHATWOOT_OUTCOME_UNKNOWN',total:2,
  firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'}]}));
 render(<DeliveryDiagnostics request={request}/>);
 fireEvent.click(screen.getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 const record=await screen.findByRole('article',{name:'Resultado incerto: Resultado na central não confirmado'});
 expect(within(record).getByText(/Confira o resultado na central antes de reenviar/)).toBeVisible();
 expect(within(record).getByText('2 tarefas')).toBeVisible();
 fireEvent.click(within(record).getByText('Ver período e código'));
 expect(within(record).getByText('Primeira tarefa criada')).toBeVisible();
 expect(within(record).getByText('Última tarefa criada')).toBeVisible();
 expect(within(record).getByText('CHATWOOT_OUTCOME_UNKNOWN')).toBeVisible();
 const dates=record.querySelectorAll('time');
 expect([...dates].map(date=>date.dateTime)).toEqual(['2026-10-15T12:00:00.000Z','2026-10-16T12:00:00.000Z']);
 expect(screen.getByText(/Fonte: tarefas de integração com a central/)).toBeVisible();
 expect(screen.getByText(/Consulta concluída em/).querySelector('time')).toHaveAttribute('dateTime');
 expect(screen.getByText(/Não representa a saúde atual/)).toBeVisible();
 expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
