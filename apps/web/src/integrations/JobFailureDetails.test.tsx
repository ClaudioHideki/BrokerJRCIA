// @vitest-environment jsdom
import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {JobFailureDetails} from './JobFailureDetails';
afterEach(cleanup);
it('does not imply diagnostics exist for legacy jobs',()=>{
 const {container}=render(<JobFailureDetails diagnostic={null}/>);
 expect(container).toBeEmptyDOMElement();
});
it('shows an observation as a past attempt without claiming remote delivery or exposing URLs',()=>{
 render(<JobFailureDetails diagnostic={{version:1,phase:'HTTP_STATUS',method:'POST',httpStatus:503,attempt:2,settlement:'UNKNOWN',failedAt:'2026-11-02T20:30:00.000Z'}}/>);
 expect(screen.getByText('Última falha observada')).toBeVisible();
 expect(screen.getByText(/HTTP 503/)).toBeInTheDocument();
 expect(screen.getByText(/resultado remoto incerto/i)).toBeInTheDocument();
 expect(screen.getByText(/Não comprova que a mensagem deixou de ser enviada/)).toBeInTheDocument();
 expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('states the absence of an HTTP response and distinguishes safe scheduled retry',()=>{
 render(<JobFailureDetails diagnostic={{version:1,phase:'TRANSPORT',method:'GET',httpStatus:null,attempt:1,settlement:'RETRY_SCHEDULED',failedAt:'2026-11-02T20:30:00.000Z'}}/>);
 expect(screen.getByText(/Sem retorno HTTP observado/)).toBeInTheDocument();
 expect(screen.getByText(/Nova tentativa agendada/)).toBeInTheDocument();
});
