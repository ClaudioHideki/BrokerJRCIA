// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EconomicGroups } from './EconomicGroups.js';
afterEach(cleanup);
const companies = [{ id: 'org-a', name: 'GoPure' }, { id: 'org-b', name: 'Construtora' }];
it('explains that grouping companies does not share tenant data or grant access', async () => {
  const request = vi.fn().mockResolvedValue({ data: [] });
  render(<EconomicGroups request={request} companies={companies} admin disabled={false} />);
  const explanation = screen.getByRole('region', { name: 'Como funcionam grupos e empresas' });
  expect(explanation).toHaveTextContent(/empresa.*organização.*tenant/i);
  expect(explanation).toHaveTextContent(/caixas de entrada.*automações.*credenciais/i);
  expect(explanation).toHaveTextContent(/grupo econômico.*não concede acesso/i);
  expect(explanation).toHaveTextContent(/usuários e acessos.*cada empresa/i);
});
it('loads subsequent group pages before allowing a company to be assigned twice', async () => {
  const first = { id: 'group-a', name: 'Grupo JRC', revision: 1, organizationIds: [] };
  const second = { id: 'group-b', name: 'Outro grupo', revision: 1, organizationIds: ['org-b'] };
  const request = vi.fn().mockImplementation(async (path: string) => path === '/groups'
    ? { data: [first], nextCursor: 'page-2' }
    : { data: [second] });
  render(<EconomicGroups request={request} companies={companies} admin disabled={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Grupo JRC' }));
  expect(screen.getByLabelText(/Construtora/)).toBeDisabled();
  expect(request).toHaveBeenCalledWith('/groups?cursor=page-2');
});
it('assigns companies with the revision read from the server and keeps other groups unavailable', async () => {
  const request = vi.fn().mockResolvedValue({ data: [
    { id: 'group-a', name: 'Grupo JRC', revision: 3, organizationIds: ['org-a'] },
    { id: 'group-b', name: 'Outro grupo', revision: 1, organizationIds: ['org-b'] },
  ] });
  render(<EconomicGroups request={request} companies={companies} admin disabled={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Grupo JRC' }));
  expect(screen.getByLabelText('GoPure')).toBeChecked();
  expect(screen.getByLabelText(/Construtora/)).toBeDisabled();
  fireEvent.click(screen.getByLabelText('GoPure'));
  request.mockResolvedValueOnce({ id: 'group-a', name: 'Grupo JRC', revision: 4, organizationIds: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar empresas do grupo' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/groups/group-a/organizations', 'PUT', { revision: 3, organizationIds: [] }));
  expect(await screen.findByRole('status')).toHaveTextContent('Grupo atualizado');
});
it('keeps support users read-only', async () => {
  const request = vi.fn().mockResolvedValue({ data: [{ id: 'g', name: 'Grupo JRC', revision: 1, organizationIds: [] }] });
  render(<EconomicGroups request={request} companies={companies} admin={false} disabled={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Grupo JRC' }));
  expect(screen.getByLabelText('GoPure')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Salvar empresas do grupo' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Nome do grupo')).not.toBeInTheDocument();
});
