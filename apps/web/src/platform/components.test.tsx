// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { CompanyTable } from './components.js';

afterEach(cleanup);

it('does not label exactly 200 fully loaded companies as a truncated result', () => {
  const companies = Array.from({ length: 200 }, (_, i) => ({
    id: `org-${i}`, name: `Empresa ${i}`, slug: `empresa-${i}`,
    status: 'ACTIVE' as const, plan: 'Inicial',
  }));
  render(<MemoryRouter><CompanyTable companies={companies} disabled={false} open={vi.fn()} compact /></MemoryRouter>);
  expect(screen.getByText('Mostrando 6 de 200 empresas carregadas')).toBeVisible();
  expect(screen.queryByText(/exibindo as 200 empresas mais recentes/i)).not.toBeInTheDocument();
});
