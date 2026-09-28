// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CompanyWorkspace, NewCompany } from './CompanyWorkspace.js';

afterEach(cleanup);

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
