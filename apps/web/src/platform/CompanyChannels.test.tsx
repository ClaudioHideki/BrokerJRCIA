// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CompanyChannels } from './CompanyChannels.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const channel = (id: string, name: string) => ({
  id,
  identity: { displayName: name },
  provider: 'QR',
  transportStatus: 'CONNECTED',
  destination: { name: 'Atendimento' },
  archivedAt: null,
});

it('shows the first admin channel page and loads more only when requested', async () => {
  let completeSecond!: (value: unknown) => void;
  const second = new Promise(resolve => { completeSecond = resolve; });
  const request = vi.fn().mockImplementation(async (path: string) => path === ''
    ? { data: [channel('first', 'Primeira caixa')], nextCursor: 'page-2' }
    : second);

  render(<CompanyChannels request={request} admin={false} disabled={false} />);
  expect(await screen.findByText('Primeira caixa')).toBeVisible();
  expect(request).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Nenhuma caixa cadastrada.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Carregar mais caixas' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('?cursor=page-2'));
  expect(screen.getByText('Primeira caixa')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Carregando mais caixas…' })).toBeDisabled();
  completeSecond({ data: [channel('second', 'Segunda caixa')] });
  expect(await screen.findByText('Segunda caixa')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Carregar mais caixas' })).not.toBeInTheDocument();
});

it('keeps loaded channels visible and reports a repeated cursor', async () => {
  const request = vi.fn().mockResolvedValue({ data: [channel('first', 'Primeira caixa')], nextCursor: 'stuck' });
  render(<CompanyChannels request={request} admin={false} disabled={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Carregar mais caixas' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/não avançou/i);
  expect(screen.getByText('Primeira caixa')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Carregar mais caixas' })).not.toBeInTheDocument();
  expect(request).toHaveBeenCalledTimes(2);
});

it('refreshes from page one after archiving and offers the new continuation cursor', async () => {
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
  let firstPages = 0;
  const request = vi.fn().mockImplementation(async (path: string, method?: string) => {
    if (method === 'POST' && path === '/first/archive') return { ok: true };
    if (path === '') {
      firstPages++;
      return firstPages === 1
        ? { data: [channel('first', 'Primeira caixa')], nextCursor: 'old-cursor' }
        : { data: [{ ...channel('first', 'Primeira caixa'), archivedAt: '2026-09-28T12:00:00Z' }], nextCursor: 'new-cursor' };
    }
    if (path === '?cursor=new-cursor') return { data: [channel('second', 'Segunda caixa')] };
    throw new Error(`Unexpected path ${path}`);
  });
  render(<CompanyChannels request={request} admin disabled={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Arquivar cadastro' }));
  expect(await screen.findByRole('button', { name: 'Restaurar cadastro' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Carregar mais caixas' }));
  expect(await screen.findByText('Segunda caixa')).toBeVisible();
  expect(request).toHaveBeenCalledWith('?cursor=new-cursor');
  expect(request).not.toHaveBeenCalledWith('?cursor=old-cursor');
});
