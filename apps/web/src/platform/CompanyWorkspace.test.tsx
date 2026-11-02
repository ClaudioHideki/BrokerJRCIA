// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CompanyWorkspace, NewCompany } from './CompanyWorkspace.js';

afterEach(cleanup);

it.each([true,false])('lets monitoring inspect delivery history read-only for admin=%s without conflating the counters',async(admin)=>{
 const request=vi.fn(async()=>({data:[{status:'UNKNOWN',code:'CHATWOOT_OUTCOME_UNKNOWN',total:2,
  firstSeenAt:'2026-10-15T12:00:00.000Z',lastSeenAt:'2026-10-16T12:00:00.000Z'}]}));
 render(<CompanyWorkspace
  company={{id:'org-a',name:'Empresa A',slug:'empresa-a',status:'ACTIVE',plan:'Inicial'}}
  members={[]} monitor={{connections:1,queue:0,failures:0,webhooks:0}} loading={false} admin={admin} disabled={false} defaultTab="monitor"
  saveCompany={vi.fn()} saveMember={vi.fn()} acknowledge={vi.fn()} refresh={vi.fn()} integrationRequest={request}
 />);
 expect(screen.getAllByRole('tab')).toHaveLength(7);
 const diagnostics=screen.getByRole('region',{name:'Entregas à central de Empresa A'});
 expect(request).not.toHaveBeenCalled();
 fireEvent.click(within(diagnostics).getByRole('button',{name:'Diagnóstico de todas as entregas'}));
 expect(await within(diagnostics).findByText('2 tarefas')).toBeVisible();
 expect(request).toHaveBeenCalledExactlyOnceWith('/jobs/summary');
 expect(within(diagnostics).queryByRole('button',{name:/reenviar|reprocessar/i})).not.toBeInTheDocument();
 expect(screen.getByRole('tab',{name:'Monitoramento'})).toHaveAttribute('aria-selected','true');
});

it('labels the new-company flag as enabling automations and explains its effect', () => {
  render(<NewCompany disabled={false} cancel={vi.fn()} submit={vi.fn().mockResolvedValue(undefined)} />);
  expect(screen.getByRole('checkbox', { name: 'Habilitar automações da empresa' })).toBeVisible();
  expect(screen.queryByText('Manter fluxos da versão anterior')).not.toBeInTheDocument();
  expect(screen.getByText(/desativar interrompe novas execuções/i)).toBeVisible();
});

it('uses the same flag meaning while editing the company plan', () => {
  render(<CompanyWorkspace
    company={{ id: 'org-a', name: 'Empresa A', slug: 'empresa-a', status: 'ACTIVE', plan: 'Inicial', flowsEnabled: true }}
    members={[]} monitor={null} loading={false} admin disabled={false} defaultTab="plan"
    saveCompany={vi.fn().mockResolvedValue(undefined)} saveMember={vi.fn().mockResolvedValue(undefined)}
    acknowledge={vi.fn()} refresh={vi.fn()}
  />);
  expect(screen.getByRole('checkbox', { name: 'Habilitar automações da empresa' })).toBeChecked();
  expect(screen.queryByText('Manter fluxos da versão anterior')).not.toBeInTheDocument();
  expect(screen.getByText(/desativar interrompe novas execuções/i)).toBeVisible();
});

it('labels the audit acknowledgment as an administrative intervention, not a support ticket', () => {
  render(<CompanyWorkspace
    company={{ id: 'org-a', name: 'Empresa A', slug: 'empresa-a', status: 'ACTIVE', plan: 'Inicial' }}
    members={[]} monitor={null} loading={false} admin disabled={false} defaultTab="support"
    saveCompany={vi.fn().mockResolvedValue(undefined)} saveMember={vi.fn().mockResolvedValue(undefined)}
    acknowledge={vi.fn()} refresh={vi.fn()}
  />);
  expect(screen.getByRole('heading', { name: 'Intervenção administrativa' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Registrar intervenção' })).toBeVisible();
  expect(screen.queryByText('Registrar atendimento de suporte')).not.toBeInTheDocument();
});
