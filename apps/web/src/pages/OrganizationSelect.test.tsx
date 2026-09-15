// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { OrganizationSelectPage } from './OrganizationSelect.js';

const selectOrganization = vi.fn();

vi.mock('../auth/SessionProvider.js', () => ({
  useSession: () => ({
    status: 'selecting',
    selectionOrganizations: [
      {
        id: '92776cb0-bcba-45c0-98a3-2937fefdfdaf',
        name: 'JRC Matriz',
        slug: 'jrc-matriz',
        role: 'OWNER',
      },
      {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'JRC Filial',
        slug: 'jrc-filial',
        role: 'ADMIN',
      },
    ],
    selectionPending: false,
    notice: null,
    selectOrganization,
  }),
}));

describe('OrganizationSelectPage', () => {
  it('identifica cada ação de acesso pela organização correspondente', () => {
    render(
      <MemoryRouter>
        <OrganizationSelectPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Acessar JRC Matriz' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Acessar JRC Filial' })).toBeVisible();
  });
});
